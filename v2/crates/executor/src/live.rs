//! A running session's live endpoints, served by the executor at `/sessions/{id}/live`, and
//! its automation at `/sessions/{id}/mcp`: requests go on to the session's runner, which
//! serves them on a socket in its runtime directory. The live path itself answers with a
//! page that shows the session.

use std::sync::Arc;

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Path, Request, State, WebSocketUpgrade, ws::Message},
    http::{StatusCode, Uri, header},
    response::{Html, IntoResponse, Response},
    routing::{any, get},
};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};
use tracing::debug;

use crate::sessions::{Error, Sessions};

pub fn path(session_id: &str) -> String {
    format!("/sessions/{session_id}/live")
}

pub fn mcp_path(session_id: &str) -> String {
    format!("/sessions/{session_id}/mcp")
}

pub fn tunnel_path(session_id: &str) -> String {
    format!("/sessions/{session_id}/tunnel")
}

pub fn router(sessions: Arc<Sessions>) -> Router {
    Router::new()
        .route("/sessions/{id}/live", get(viewer))
        .route("/sessions/{id}/live/", get(viewer))
        .route("/sessions/{id}/live/{*rest}", any(forward))
        .route("/sessions/{id}/mcp", any(mcp))
        .route("/sessions/{id}/tunnel", get(tunnel))
        .with_state(sessions)
}

async fn viewer() -> Html<&'static str> {
    Html(include_str!("viewer.html"))
}

async fn forward(
    State(sessions): State<Arc<Sessions>>,
    Path((id, rest)): Path<(String, String)>,
    request: Request,
) -> Response {
    forward_to(&sessions, &id, &format!("/{rest}"), request).await
}

async fn mcp(
    State(sessions): State<Arc<Sessions>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    forward_to(&sessions, &id, "/mcp", request).await
}

/// Passes the request on to the session's runner, as a request for `path` there.
async fn forward_to(sessions: &Sessions, id: &str, path: &str, mut request: Request) -> Response {
    let live = match sessions.live(id) {
        Ok(live) => live,
        Err(err) => return refuse(err),
    };
    // The runner knows nothing of the executor's paths or its token.
    *request.uri_mut() = match path.parse::<Uri>() {
        Ok(uri) => uri,
        Err(err) => return (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    };
    request.headers_mut().remove(header::AUTHORIZATION);

    let answered = async {
        let stream = UnixStream::connect(&live.socket).await?;
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
        tokio::spawn(async move {
            if let Err(err) = connection.await {
                debug!(%err, "the connection to a runner failed");
            }
        });
        anyhow::Ok(sender.send_request(request).await?)
    };
    match answered.await {
        Ok(response) => response.map(Body::new),
        Err(err) => (StatusCode::BAD_GATEWAY, format!("{err:#}")).into_response(),
    }
}

/// A client attaches the session's local tunnel: the WebSocket's binary messages are the
/// tunnel's bytes, passed to the runner and back as they are.
async fn tunnel(
    State(sessions): State<Arc<Sessions>>,
    Path(id): Path<String>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let live = match sessions.live(&id) {
        Ok(live) => live,
        Err(err) => return refuse(err),
    };
    upgrade
        .protocols([aperture_tunnel::SUBPROTOCOL])
        .on_upgrade(move |client| async move {
            let Ok(runner) = UnixStream::connect(&live.tunnel_socket).await else {
                return;
            };
            let (mut from_runner, mut to_runner) = runner.into_split();
            let (mut to_client, mut from_client) = client.split();
            let up = async {
                while let Some(Ok(message)) = from_client.next().await {
                    let sent = match message {
                        Message::Binary(data) => to_runner.write_all(&data).await,
                        Message::Close(_) => break,
                        _ => Ok(()),
                    };
                    if sent.is_err() {
                        break;
                    }
                }
            };
            let down = async {
                let mut chunk = vec![0; 16 * 1024];
                while let Ok(read) = from_runner.read(&mut chunk).await {
                    let data = Bytes::copy_from_slice(&chunk[..read]);
                    if read == 0 || to_client.send(Message::Binary(data)).await.is_err() {
                        break;
                    }
                }
            };
            // Either side ending ends the tunnel.
            tokio::select! {
                () = up => {}
                () = down => {}
            }
        })
}

/// Sends the session's runner a request with a JSON body, and fails unless it took it.
pub async fn put(socket: &std::path::Path, path: &str, body: Vec<u8>) -> anyhow::Result<()> {
    let stream = UnixStream::connect(socket).await?;
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
    tokio::spawn(connection);
    let request = axum::http::Request::builder()
        .method(axum::http::Method::PUT)
        .uri(path)
        .header(header::HOST, "runner")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))?;
    let response = sender.send_request(request).await?;
    let status = response.status();
    let said = response.into_body().collect().await?.to_bytes();
    anyhow::ensure!(status.is_success(), "{}", String::from_utf8_lossy(&said));
    Ok(())
}

fn refuse(err: Error) -> Response {
    let status = match &err {
        Error::NotRunning(_) => StatusCode::CONFLICT,
        Error::Store(
            aperture_store::StoreError::SessionNotFound(_)
            | aperture_store::StoreError::InvalidId(_),
        ) => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, err.to_string()).into_response()
}
