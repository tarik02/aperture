//! The browser's way out. The browser lives in a network of its own that leads nowhere;
//! everything it sends goes to this proxy, SOCKS5 on a Unix socket bound into its sandbox,
//! which decides for every connection whether it may be made and makes it from here.
//!
//! The browser gives names, not addresses, so names are resolved here and the addresses
//! they resolve to are what is checked: a name that resolves to this machine is no way
//! around the check. What is this machine's and its network's is refused unless the node
//! allows it: loopback, private and link-local addresses, where other sessions, the
//! executor and the node's neighbours are.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::Path,
    sync::Arc,
    time::Duration,
};

use fast_socks5::{
    ReplyError, Socks5Command, server::Socks5ServerProtocol, util::target_addr::TargetAddr,
};
use ipnet::IpNet;
use tokio::{
    net::{TcpStream, UnixListener, UnixStream, lookup_host},
    time::timeout,
};
use tracing::debug;

const CONNECT_WITHIN: Duration = Duration::from_secs(20);

/// What the browser may reach.
pub struct Policy {
    /// Addresses that may be reached although they are local.
    allow: Vec<IpNet>,
}

impl Policy {
    pub fn new(allow: &[String]) -> anyhow::Result<Self> {
        let allow = allow
            .iter()
            .map(|entry| {
                entry
                    .parse::<IpNet>()
                    .or_else(|_| entry.parse::<IpAddr>().map(IpNet::from))
                    .map_err(|_| anyhow::anyhow!("{entry:?} is not an address or a network"))
            })
            .collect::<anyhow::Result<_>>()?;
        Ok(Self { allow })
    }

    fn permits(&self, address: IpAddr) -> bool {
        // An IPv4 address in IPv6's clothes is the IPv4 address.
        let address = match address {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(address, IpAddr::V4),
            v4 => v4,
        };
        !is_local(address) || self.allow.iter().any(|network| network.contains(&address))
    }
}

/// Whether the address is this machine's or its own network's, rather than the internet's.
fn is_local(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                // Shared address space, as carrier-grade NATs and overlay networks use.
                || Ipv4Addr::new(100, 64, 0, 0) == Ipv4Addr::from(u32::from(v4) & 0xffc0_0000)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6 == Ipv6Addr::UNSPECIFIED
        }
    }
}

/// Serves the proxy on `socket` until the listener fails.
pub async fn serve(socket: &Path, policy: Policy) -> std::io::Result<()> {
    let _ = std::fs::remove_file(socket);
    let listener = UnixListener::bind(socket)?;
    let policy = Arc::new(policy);
    loop {
        let (browser, _) = listener.accept().await?;
        let policy = policy.clone();
        tokio::spawn(async move {
            if let Err(err) = connect(browser, &policy).await {
                debug!("a connection of the browser ended: {err:#}");
            }
        });
    }
}

async fn connect(browser: UnixStream, policy: &Policy) -> anyhow::Result<()> {
    let (request, command, target) = Socks5ServerProtocol::accept_no_auth(browser)
        .await?
        .read_command()
        .await?;
    // Datagrams have no way out: the browser is told to do without them.
    if command != Socks5Command::TCPConnect {
        request
            .reply_error(&ReplyError::CommandNotSupported)
            .await?;
        return Ok(());
    }
    let resolved: Vec<SocketAddr> = match &target {
        TargetAddr::Ip(address) => vec![*address],
        TargetAddr::Domain(name, port) => match lookup_host((name.as_str(), *port)).await {
            Ok(addresses) => addresses.collect(),
            Err(_) => {
                request.reply_error(&ReplyError::HostUnreachable).await?;
                return Ok(());
            }
        },
    };
    let permitted: Vec<SocketAddr> = resolved
        .iter()
        .copied()
        .filter(|address| policy.permits(address.ip()))
        .collect();
    if permitted.is_empty() {
        debug!(?target, "refused: a local address");
        request
            .reply_error(&ReplyError::ConnectionNotAllowed)
            .await?;
        return Ok(());
    }

    // The addresses that were checked are the ones connected to.
    let mut connected = None;
    for address in permitted {
        if let Ok(Ok(stream)) = timeout(CONNECT_WITHIN, TcpStream::connect(address)).await {
            connected = Some(stream);
            break;
        }
    }
    let Some(mut destination) = connected else {
        request.reply_error(&ReplyError::HostUnreachable).await?;
        return Ok(());
    };
    let _ = destination.set_nodelay(true);
    let mut browser = request.reply_success(destination.local_addr()?).await?;
    tokio::io::copy_bidirectional(&mut browser, &mut destination).await?;
    Ok(())
}
