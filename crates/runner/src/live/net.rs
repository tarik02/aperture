//! A peer's UDP sockets, one per local address. The session offers host candidates only: the
//! browser probes them and answers come back from the same address, so its own candidates
//! (often obfuscated mDNS names) are never needed.

use std::{
    collections::HashMap,
    io,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use aperture_runner::PortRange;
use str0m::Candidate;
use tokio::{net::UdpSocket, sync::mpsc, task::JoinSet};
use tracing::{debug, warn};

const MAX_DATAGRAM: usize = 2000;

/// Datagrams buffered between the sockets and the peer.
const DATAGRAM_BUFFER: usize = 256;

pub struct Datagram {
    pub source: SocketAddr,
    pub destination: SocketAddr,
    pub data: Vec<u8>,
}

/// Dropping them stops reading.
pub struct Sockets {
    sockets: HashMap<SocketAddr, Arc<UdpSocket>>,
    datagrams: mpsc::Receiver<Datagram>,
    _readers: JoinSet<()>,
}

impl Sockets {
    /// Binds a socket on every local address, within `ports` when given, and returns them
    /// with their host candidates; none when no address could be bound.
    pub async fn bind(ports: Option<PortRange>) -> (Self, Vec<Candidate>) {
        let mut readers = JoinSet::new();
        let (datagrams_tx, datagrams) = mpsc::channel(DATAGRAM_BUFFER);
        let mut sockets = HashMap::new();
        let mut candidates = Vec::new();
        for ip in local_addresses() {
            let socket = match bind(ip, ports).await {
                Ok(socket) => Arc::new(socket),
                Err(err) => {
                    debug!(%ip, %err, "skipping address");
                    continue;
                }
            };
            let addr = match socket.local_addr() {
                Ok(addr) => addr,
                Err(err) => {
                    debug!(%ip, %err, "skipping address");
                    continue;
                }
            };
            match Candidate::host(addr, "udp") {
                Ok(candidate) => candidates.push(candidate),
                Err(err) => {
                    debug!(%addr, %err, "skipping candidate");
                    continue;
                }
            }
            sockets.insert(addr, socket.clone());
            readers.spawn(read_socket(socket, addr, datagrams_tx.clone()));
        }
        let sockets = Self {
            sockets,
            datagrams,
            _readers: readers,
        };
        (sockets, candidates)
    }

    /// The next datagram any socket received.
    pub async fn recv(&mut self) -> Option<Datagram> {
        self.datagrams.recv().await
    }

    /// Sends `contents` to `destination` from the socket bound to `source`.
    pub async fn send(&self, source: SocketAddr, destination: SocketAddr, contents: &[u8]) {
        let Some(socket) = self.sockets.get(&source) else {
            return;
        };
        if let Err(err) = socket.send_to(contents, destination).await {
            debug!(%err, "failed to send a datagram");
        }
    }
}

async fn read_socket(
    socket: Arc<UdpSocket>,
    destination: SocketAddr,
    datagrams: mpsc::Sender<Datagram>,
) {
    let mut buf = vec![0; MAX_DATAGRAM];
    loop {
        let (len, source) = match socket.recv_from(&mut buf).await {
            Ok(received) => received,
            Err(err) => {
                debug!(%err, "socket read failed");
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            }
        };
        let datagram = Datagram {
            source,
            destination,
            data: buf[..len].to_vec(),
        };
        if datagrams.send(datagram).await.is_err() {
            return;
        }
    }
}

/// Binds the first free port of `ports`; any port without a range.
async fn bind(ip: IpAddr, ports: Option<PortRange>) -> io::Result<UdpSocket> {
    let Some(ports) = ports else {
        return UdpSocket::bind(SocketAddr::new(ip, 0)).await;
    };
    for port in ports.first..=ports.last {
        match UdpSocket::bind(SocketAddr::new(ip, port)).await {
            Err(err) if err.kind() == io::ErrorKind::AddrInUse => {}
            result => return result,
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AddrInUse,
        format!("ports {}-{} are all in use", ports.first, ports.last),
    ))
}

/// Addresses to offer as host candidates. Loopback is included for same-machine browsers
/// that accept it; LAN addresses cover the rest.
fn local_addresses() -> Vec<IpAddr> {
    match if_addrs::get_if_addrs() {
        Ok(interfaces) => interfaces
            .into_iter()
            .map(|interface| interface.ip())
            .filter(|ip| match ip {
                IpAddr::V4(_) => true,
                // Link-local IPv6 needs a scope id that SDP candidates cannot carry.
                IpAddr::V6(ip) => !ip.is_unicast_link_local(),
            })
            .collect(),
        Err(err) => {
            warn!(%err, "failed to list network interfaces");
            vec![IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)]
        }
    }
}
