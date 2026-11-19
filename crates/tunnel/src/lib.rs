//! The tunnel a session's connections travel through to be made somewhere else: on the
//! machine of a client that attached one, or at an operator's.
//!
//! A tunnel is one stream of bytes, usually a WebSocket's binary messages, with yamux on
//! it. The session's end opens a yamux stream for every connection and asks on it, as a
//! SOCKS5 client, for the connection to be made; the other end answers as a SOCKS5 server
//! and makes it. Nothing on the wire is Aperture's own, so anything that speaks yamux and
//! SOCKS5 can be the other end.

use std::{
    io,
    sync::Arc,
    sync::atomic::{AtomicBool, Ordering},
};

use bytes::Bytes;
use fast_socks5::{
    ReplyError, Socks5Command,
    client::{Config as SocksConfig, Socks5Stream},
    server::Socks5ServerProtocol,
    util::target_addr::TargetAddr,
};
use futures_util::{SinkExt, StreamExt, future};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};
use tokio_util::io::{CopyToBytes, SinkWriter, StreamReader};
use tokio_yamux::{Config, Control, Session};
use tracing::debug;

/// The WebSocket subprotocol of a tunnel a client attaches to a session.
pub const SUBPROTOCOL: &str = "aperture-tunnel.v1";

/// A WebSocket as the stream of bytes its binary messages carry.
pub fn bytes<S>(socket: WebSocketStream<S>) -> impl AsyncRead + AsyncWrite + Unpin + Send
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let (sink, stream) = socket.split();
    let incoming = stream.filter_map(|message| {
        future::ready(match message {
            Ok(Message::Binary(data)) => Some(Ok(data)),
            Ok(_) => None,
            Err(err) => Some(Err(io::Error::other(err))),
        })
    });
    let outgoing = sink
        .sink_map_err(io::Error::other)
        .with(|data: Bytes| future::ready(Ok::<_, io::Error>(Message::Binary(data))));
    tokio::io::join(
        StreamReader::new(Box::pin(incoming)),
        SinkWriter::new(CopyToBytes::new(Box::pin(outgoing))),
    )
}

/// The session's end of a tunnel.
pub struct Tunnel {
    control: Control,
    closed: Arc<AtomicBool>,
}

impl Tunnel {
    /// Starts the tunnel on `stream`. It lasts until the stream ends or the tunnel is
    /// dropped.
    pub fn new(stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static) -> Self {
        let mut session = Session::new_client(stream, Config::default());
        let control = session.control();
        let closed = Arc::new(AtomicBool::new(false));
        let ended = closed.clone();
        tokio::spawn(async move {
            // The session does its work when polled; the other end opens no streams.
            while let Some(Ok(_)) = session.next().await {}
            ended.store(true, Ordering::Relaxed);
        });
        Self { control, closed }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// Has the other end connect to `host`, which it resolves, and gives the connection.
    pub async fn connect(
        &self,
        host: &str,
        port: u16,
    ) -> io::Result<impl AsyncRead + AsyncWrite + Unpin + Send + use<>> {
        let stream = self
            .control
            .clone()
            .open_stream()
            .await
            .map_err(io::Error::other)?;
        let mut stream = Socks5Stream::use_stream(stream, None, SocksConfig::default())
            .await
            .map_err(io::Error::other)?;
        stream
            .request(
                Socks5Command::TCPConnect,
                TargetAddr::Domain(host.to_owned(), port),
            )
            .await
            .map_err(io::Error::other)?;
        Ok(stream)
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let mut control = self.control.clone();
        tokio::spawn(async move { control.close().await });
    }
}

/// The other end of a tunnel: makes, from this machine, the connections the session asks
/// for, until `stream` ends.
pub async fn serve(stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static) {
    let mut session = Session::new_server(stream, Config::default());
    while let Some(Ok(asked)) = session.next().await {
        tokio::spawn(async move {
            if let Err(err) = answer(asked).await {
                debug!("a tunnelled connection ended: {err:#}");
            }
        });
    }
}

async fn answer(asked: impl AsyncRead + AsyncWrite + Unpin) -> anyhow::Result<()> {
    let (request, command, target) = Socks5ServerProtocol::accept_no_auth(asked)
        .await?
        .read_command()
        .await?;
    if command != Socks5Command::TCPConnect {
        request
            .reply_error(&ReplyError::CommandNotSupported)
            .await?;
        return Ok(());
    }
    let connected = match &target {
        TargetAddr::Ip(address) => TcpStream::connect(address).await,
        TargetAddr::Domain(host, port) => TcpStream::connect((host.as_str(), *port)).await,
    };
    let mut destination = match connected {
        Ok(destination) => destination,
        Err(_) => {
            request.reply_error(&ReplyError::HostUnreachable).await?;
            return Ok(());
        }
    };
    let _ = destination.set_nodelay(true);
    let mut asked = request.reply_success(destination.local_addr()?).await?;
    tokio::io::copy_bidirectional(&mut asked, &mut destination).await?;
    Ok(())
}
