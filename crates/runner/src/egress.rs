//! The browser's way out. The browser lives in a network of its own that leads nowhere;
//! everything it sends goes to this proxy, SOCKS5 on a Unix socket bound into its sandbox,
//! which decides for every connection where it goes, by the session's rules (see
//! [`proxy`](aperture_runner::proxy)): made from here, through an upstream proxy, through
//! a tunnel, or not at all.
//!
//! The browser gives names, not addresses. For a connection made from here the name is
//! resolved here and the addresses it resolves to are what is checked: a name that
//! resolves to this machine is no way around the check. What is this machine's and its
//! network's is refused unless the node allows it: loopback, private and link-local
//! addresses, where other sessions, the executor and the node's neighbours are. The same
//! goes for where a session's upstreams are, which whoever configures the session names.
//! What an upstream then reaches is the upstream's own business.
//!
//! Names are resolved by the session's own rules for them (see [`names`](crate::names)),
//! and the browser's own questions, which it has when it has a network of its own, are
//! answered here by the same rules.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::Path,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use anyhow::{Context, bail, ensure};
use aperture_runner::proxy::{Config, Proxy, Route, Routes, Scheme, Tunnel as TunnelRoute};
use aperture_tunnel::Tunnel;
use base64::Engine as _;
use fast_socks5::{
    AuthenticationMethod, ReplyError, Socks5Command,
    client::{Config as SocksConfig, Socks5Stream},
    server::Socks5ServerProtocol,
    util::target_addr::TargetAddr,
};
use ipnet::IpNet;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpStream, UnixListener, UnixStream},
    time::timeout,
};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::{HeaderValue, header},
};
use tracing::{debug, info};

use crate::{certificates::Certificates, names::Names};

const CONNECT_WITHIN: Duration = Duration::from_secs(20);

/// What a node lets its sessions reach of what is local to it.
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

/// A connection as bytes, whatever carries them.
trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// Why a connection was not made, as the browser is told.
struct Refused(ReplyError, anyhow::Error);

impl Refused {
    fn unreachable(reason: anyhow::Error) -> Self {
        Self(ReplyError::HostUnreachable, reason)
    }
}

/// A configuration as the session goes by it.
struct Rules {
    routes: Routes,
    names: Names,
}

impl Rules {
    fn new(config: &Config, policy: &Policy) -> Result<Arc<Self>, String> {
        let routes = config.compile()?;
        // As with upstreams: whoever configures a session reaches no more of the node's
        // network through its resolvers than its browser does.
        if let Some(local) = routes
            .names
            .servers
            .iter()
            .find(|server| !policy.permits(**server))
        {
            return Err(format!("dns server {local} is local to the node"));
        }
        let names = Names::new(&routes.names).map_err(|err| format!("{err:#}"))?;
        Ok(Arc::new(Self { routes, names }))
    }
}

pub struct Egress {
    policy: Policy,
    rules: RwLock<Arc<Rules>>,
    certificates: Arc<Certificates>,
    /// The tunnels dialed so far, by their upstream's name, each with what it was dialed
    /// with.
    tunnels: tokio::sync::Mutex<HashMap<String, (TunnelRoute, Arc<Tunnel>)>>,
    /// The tunnel a client attached.
    local: Mutex<Option<Arc<Tunnel>>>,
}

impl Egress {
    pub fn new(
        policy: Policy,
        config: &Config,
        certificates: Arc<Certificates>,
    ) -> anyhow::Result<Arc<Self>> {
        let rules = Rules::new(config, &policy).map_err(anyhow::Error::msg)?;
        Ok(Arc::new(Self {
            policy,
            rules: RwLock::new(rules),
            certificates,
            tunnels: tokio::sync::Mutex::default(),
            local: Mutex::default(),
        }))
    }

    /// Takes a new configuration. Connections made from now on go by it; those that are
    /// open stay as they are.
    pub fn update(&self, config: &Config) -> Result<(), String> {
        let rules = Rules::new(config, &self.policy)?;
        *self.rules.write().expect("not poisoned") = rules;
        Ok(())
    }

    fn rules(&self) -> Arc<Rules> {
        self.rules.read().expect("not poisoned").clone()
    }

    /// Serves the proxy on `socket` until the listener fails.
    pub async fn serve(self: Arc<Self>, socket: &Path) -> std::io::Result<()> {
        // The socket an earlier run left; binding says what else is in the way.
        let _ = std::fs::remove_file(socket);
        let listener = UnixListener::bind(socket)?;
        loop {
            let (browser, _) = listener.accept().await?;
            let egress = self.clone();
            tokio::spawn(async move {
                if let Err(err) = egress.connect(browser).await {
                    debug!("a connection of the browser ended: {err:#}");
                }
            });
        }
    }

    /// Takes the tunnels clients attach, on `socket`: each connection there is a tunnel's
    /// bytes. A session has one such tunnel, and a new one takes the place of the last.
    pub async fn serve_local(self: Arc<Self>, socket: &Path) -> std::io::Result<()> {
        // As in `serve`.
        let _ = std::fs::remove_file(socket);
        let listener = UnixListener::bind(socket)?;
        loop {
            let (attached, _) = listener.accept().await?;
            info!("a client attached the local tunnel");
            *self.local.lock().expect("not poisoned") = Some(Arc::new(Tunnel::new(attached)));
        }
    }

    /// Answers the names the browser asks for, on `socket`: DNS messages, each after its
    /// length, as DNS has them over a stream.
    pub async fn serve_names(self: Arc<Self>, socket: &Path) -> std::io::Result<()> {
        // As in `serve`.
        let _ = std::fs::remove_file(socket);
        let listener = UnixListener::bind(socket)?;
        loop {
            let (mut asking, _) = listener.accept().await?;
            let egress = self.clone();
            tokio::spawn(async move {
                // Ends when whoever asks is done.
                while let Ok(length) = asking.read_u16().await {
                    let mut asked = vec![0; length.into()];
                    if asking.read_exact(&mut asked).await.is_err() {
                        break;
                    }
                    let answer = match egress.rules().names.answer(&asked).await {
                        Ok(answer) => answer,
                        Err(err) => {
                            debug!("a question of the browser was not answered: {err:#}");
                            break;
                        }
                    };
                    let Ok(length) = u16::try_from(answer.len()) else {
                        break;
                    };
                    let mut framed = length.to_be_bytes().to_vec();
                    framed.extend(answer);
                    if asking.write_all(&framed).await.is_err() {
                        break;
                    }
                }
            });
        }
    }

    async fn connect(&self, browser: UnixStream) -> anyhow::Result<()> {
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
        let (host, port) = match &target {
            TargetAddr::Ip(address) => (address.ip().to_string(), address.port()),
            TargetAddr::Domain(name, port) => (name.clone(), *port),
        };
        let way = self.rules().routes.route(&host, port).clone();
        let (to, to_port) = match &way.to {
            Some(to) => (to.host.as_str(), to.port.unwrap_or(port)),
            None => (host.as_str(), port),
        };
        let mut destination = match self.reach(&way.route, to, to_port).await {
            Ok(destination) => destination,
            Err(Refused(reply, reason)) => {
                debug!(host, port, "not connected: {reason:#}");
                request.reply_error(&reply).await?;
                return Ok(());
            }
        };
        let unspecified = SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0));
        let mut browser = request.reply_success(unspecified).await?;
        if way.tls {
            let mut browser = self.certificates.accept(&host, browser).await?;
            tokio::io::copy_bidirectional(&mut browser, &mut destination).await?;
            return Ok(());
        }
        tokio::io::copy_bidirectional(&mut browser, &mut destination).await?;
        Ok(())
    }

    /// Makes the connection to `host` the way its route says.
    async fn reach(&self, route: &Route, host: &str, port: u16) -> Result<Box<dyn Io>, Refused> {
        match route {
            Route::Direct => Ok(Box::new(self.dial(host, port).await?)),
            Route::Refuse => Err(Refused(
                ReplyError::ConnectionNotAllowed,
                anyhow::anyhow!("refused by a rule"),
            )),
            Route::Local => {
                let tunnel = self.local.lock().expect("not poisoned").clone();
                let tunnel = tunnel.filter(|tunnel| !tunnel.is_closed()).ok_or_else(|| {
                    Refused::unreachable(anyhow::anyhow!("no local tunnel is attached"))
                })?;
                let through = tunnel.connect(host, port).await;
                Ok(Box::new(
                    through.map_err(|err| Refused::unreachable(err.into()))?,
                ))
            }
            Route::Proxy(proxy) => {
                let through = self.through_proxy(proxy, host, port).await;
                through.map_err(Refused::unreachable)
            }
            Route::Tunnel(route) => {
                let tunnel = self.tunnel(route).await.map_err(Refused::unreachable)?;
                let through = tunnel.connect(host, port).await;
                Ok(Box::new(
                    through.map_err(|err| Refused::unreachable(err.into()))?,
                ))
            }
        }
    }

    /// Connects from here, to an address the node lets its sessions reach.
    async fn dial(&self, host: &str, port: u16) -> Result<TcpStream, Refused> {
        let resolved = match self.rules().names.addresses(host).await {
            Ok(addresses) => addresses,
            Err(err) => return Err(Refused::unreachable(err)),
        };
        let permitted: Vec<SocketAddr> = resolved
            .into_iter()
            .filter(|address| self.policy.permits(*address))
            .map(|address| SocketAddr::new(address, port))
            .collect();
        if permitted.is_empty() {
            return Err(Refused(
                ReplyError::ConnectionNotAllowed,
                anyhow::anyhow!("a local address"),
            ));
        }
        // The addresses that were checked are the ones connected to.
        let mut unanswered = anyhow::anyhow!("no address answered");
        for address in permitted {
            match timeout(CONNECT_WITHIN, TcpStream::connect(address)).await {
                Ok(Ok(stream)) => {
                    // Without it the connection is only slower.
                    let _ = stream.set_nodelay(true);
                    return Ok(stream);
                }
                Ok(Err(err)) => unanswered = anyhow::Error::from(err).context(address),
                Err(_) => unanswered = anyhow::anyhow!("{address} did not answer in time"),
            }
        }
        Err(Refused::unreachable(unanswered))
    }

    async fn through_proxy(
        &self,
        proxy: &Proxy,
        host: &str,
        port: u16,
    ) -> anyhow::Result<Box<dyn Io>> {
        let stream = self
            .dial(&proxy.host, proxy.port)
            .await
            .map_err(|Refused(_, reason)| reason.context("the proxy was not reached"))?;
        match proxy.scheme {
            Scheme::Socks5 => {
                let auth = proxy.credentials.clone().map(|(username, password)| {
                    AuthenticationMethod::Password { username, password }
                });
                let mut stream =
                    Socks5Stream::use_stream(stream, auth, SocksConfig::default()).await?;
                let target = TargetAddr::Domain(host.to_owned(), port);
                stream.request(Socks5Command::TCPConnect, target).await?;
                Ok(Box::new(stream))
            }
            Scheme::Http => Ok(Box::new(http_connect(stream, proxy, host, port).await?)),
            Scheme::Https => {
                let connector = native_tls::TlsConnector::new()?;
                let secured = tokio_native_tls::TlsConnector::from(connector)
                    .connect(&proxy.host, stream)
                    .await?;
                Ok(Box::new(http_connect(secured, proxy, host, port).await?))
            }
        }
    }

    /// The tunnel of an upstream, dialed when first needed and again after it ended or
    /// what it is dialed with changed.
    async fn tunnel(&self, route: &TunnelRoute) -> anyhow::Result<Arc<Tunnel>> {
        let mut tunnels = self.tunnels.lock().await;
        if let Some((dialed, tunnel)) = tunnels.get(&route.name)
            && dialed == route
            && !tunnel.is_closed()
        {
            return Ok(tunnel.clone());
        }
        let stream = self
            .dial(&route.host, route.port)
            .await
            .map_err(|Refused(_, reason)| reason.context("the tunnel's server was not reached"))?;
        let mut request = route.url.as_str().into_client_request()?;
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", route.auth))?,
        );
        let (socket, _) = tokio_tungstenite::client_async_tls(request, stream)
            .await
            .context("the tunnel's server refused")?;
        let tunnel = Arc::new(Tunnel::new(aperture_tunnel::bytes(socket)));
        info!(upstream = route.name, "tunnel dialed");
        tunnels.insert(route.name.clone(), (route.clone(), tunnel.clone()));
        Ok(tunnel)
    }
}

/// Asks an HTTP proxy for a connection to `host`, and gives the stream once it is one.
async fn http_connect<S: Io>(
    mut stream: S,
    proxy: &Proxy,
    host: &str,
    port: u16,
) -> anyhow::Result<S> {
    // An IPv6 address goes in brackets.
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some((username, password)) = &proxy.credentials {
        let basic =
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
        request.push_str(&format!("Proxy-Authorization: Basic {basic}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await?;

    // Byte by byte, so that nothing of what follows the answer is taken with it.
    let mut answer = Vec::new();
    while !answer.ends_with(b"\r\n\r\n") {
        ensure!(answer.len() < 16 * 1024, "the proxy's answer is too long");
        answer.push(stream.read_u8().await?);
    }
    let status = String::from_utf8_lossy(&answer);
    let status = status.lines().next().unwrap_or_default();
    if status.split_whitespace().nth(1) != Some("200") {
        bail!("the proxy answered {status:?}");
    }
    Ok(stream)
}
