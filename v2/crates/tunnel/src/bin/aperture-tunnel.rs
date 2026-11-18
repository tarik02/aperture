//! The far end of a session's tunnel, on this machine: connections the session routes
//! through the tunnel are made from here, so a session reaches what this machine reaches,
//! such as a server on its localhost.
//!
//!   aperture-tunnel attach URL    attach to a session as its local tunnel
//!   aperture-tunnel listen ADDR   wait for sessions to dial in, as an operator's tunnel

use std::net::SocketAddr;

use anyhow::Context;
use aperture_tunnel::{SUBPROTOCOL, bytes, serve};
use clap::Parser;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    handshake::server::{ErrorResponse, Request, Response},
    http::{HeaderValue, StatusCode, header},
};
use tracing::{info, warn};

#[derive(Parser)]
enum Arguments {
    /// Attach to a session as its local tunnel, until interrupted.
    Attach {
        /// The session's tunnel endpoint, `ws://…/sessions/<id>/tunnel`.
        url: String,
        /// The executor's token.
        #[arg(long, env = "APERTURE_TOKEN")]
        token: String,
    },
    /// Serve tunnels that sessions dial, as an upstream `ws+yamux+socks5://ADDR/`.
    Listen {
        addr: SocketAddr,
        /// The secret sessions give as the upstream's `auth`.
        #[arg(long, env = "APERTURE_TUNNEL_AUTH")]
        auth: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    match Arguments::parse() {
        Arguments::Attach { url, token } => {
            let mut request = url.as_str().into_client_request()?;
            let headers = request.headers_mut();
            headers.insert(
                header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))?,
            );
            headers.insert(
                header::SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_static(SUBPROTOCOL),
            );
            let (socket, _) = tokio_tungstenite::connect_async(request)
                .await
                .context("failed to attach to the session")?;
            info!("attached; the session's connections via `local` are made from here");
            serve(bytes(socket)).await;
            info!("the tunnel ended");
        }
        Arguments::Listen { addr, auth } => {
            let listener = TcpListener::bind(addr).await?;
            info!(%addr, "waiting for sessions");
            let expected = format!("Bearer {auth}");
            loop {
                let (connection, peer) = listener.accept().await?;
                let expected = expected.clone();
                tokio::spawn(async move {
                    #[expect(
                        clippy::result_large_err,
                        reason = "the handshake takes the refusal itself as the error"
                    )]
                    let check = |request: &Request, response: Response| {
                        let given = request.headers().get(header::AUTHORIZATION);
                        if given.and_then(|value| value.to_str().ok()) == Some(&expected) {
                            Ok(response)
                        } else {
                            let mut refusal = ErrorResponse::new(None);
                            *refusal.status_mut() = StatusCode::UNAUTHORIZED;
                            Err(refusal)
                        }
                    };
                    match tokio_tungstenite::accept_hdr_async(connection, check).await {
                        Ok(socket) => {
                            info!(%peer, "a session dialed in");
                            serve(bytes(socket)).await;
                        }
                        Err(err) => warn!(%peer, "refused: {err}"),
                    }
                });
            }
        }
    }
    Ok(())
}
