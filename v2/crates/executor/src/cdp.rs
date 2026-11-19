//! A running session's DevTools endpoint, served by the executor: the browser's WebSocket
//! at `/sessions/{id}/cdp`, and below it the browser's own discovery routes (`json/version`,
//! `json/list`, ...) and target WebSockets (`devtools/page/<id>`), so that a client given
//! the one URL finds the rest as it would on the browser's port.

use std::{path::PathBuf, sync::Arc};

use aperture_runner::DEVTOOLS_AUTHORITY;
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{
        OriginalUri, Path, State, WebSocketUpgrade,
        ws::{Message as ClientMessage, WebSocket},
    },
    http::{HeaderMap, Method, Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use tokio::net::UnixStream;
use tokio_tungstenite::tungstenite::{Message as BrowserMessage, protocol::WebSocketConfig};
use tracing::debug;

use crate::sessions::{Error, Presence, Sessions};

pub fn path(session_id: &str) -> String {
    format!("/sessions/{session_id}/cdp")
}

pub fn router(sessions: Arc<Sessions>) -> Router {
    Router::new()
        .route("/sessions/{id}/cdp", get(browser))
        .route("/sessions/{id}/cdp/devtools/{*target}", get(target))
        .route("/sessions/{id}/cdp/json", any(discovery))
        .route("/sessions/{id}/cdp/json/{*rest}", any(discovery))
        .with_state(sessions)
}

async fn browser(
    State(sessions): State<Arc<Sessions>>,
    Path(id): Path<String>,
    upgrade: WebSocketUpgrade,
) -> Response {
    match sessions.cdp(&id).await {
        Ok(cdp) => connect(upgrade, cdp.socket, cdp.browser_path, sessions.present(&id)),
        Err(err) => refuse(err),
    }
}

async fn target(
    State(sessions): State<Arc<Sessions>>,
    Path((id, target)): Path<(String, String)>,
    upgrade: WebSocketUpgrade,
) -> Response {
    match sessions.cdp(&id).await {
        Ok(cdp) => connect(
            upgrade,
            cdp.socket,
            format!("/devtools/{target}"),
            sessions.present(&id),
        ),
        Err(err) => refuse(err),
    }
}

/// CDP messages carry screenshots and whole documents, so neither side limits their size.
fn connect(upgrade: WebSocketUpgrade, socket: PathBuf, path: String, here: Presence) -> Response {
    upgrade
        .max_message_size(usize::MAX)
        .max_frame_size(usize::MAX)
        .on_upgrade(move |client| async move {
            let _here = here;
            let config = WebSocketConfig::default()
                .max_message_size(None)
                .max_frame_size(None);
            let url = format!("ws://{DEVTOOLS_AUTHORITY}{path}");
            let connected = async {
                let stream = UnixStream::connect(&socket).await?;
                let connected =
                    tokio_tungstenite::client_async_with_config(url, stream, Some(config)).await?;
                anyhow::Ok(connected.0)
            };
            match connected.await {
                Ok(browser) => relay(client, browser).await,
                Err(err) => debug!("failed to reach the browser: {err:#}"),
            }
        })
}

async fn relay<S>(client: WebSocket, browser: tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut to_client, mut from_client) = client.split();
    let (mut to_browser, mut from_browser) = browser.split();
    let up = async {
        while let Some(Ok(message)) = from_client.next().await {
            let message = match message {
                ClientMessage::Text(text) => BrowserMessage::text(text.as_str()),
                ClientMessage::Binary(bytes) => BrowserMessage::binary(bytes),
                ClientMessage::Ping(bytes) => BrowserMessage::Ping(bytes),
                ClientMessage::Pong(bytes) => BrowserMessage::Pong(bytes),
                ClientMessage::Close(_) => break,
            };
            if to_browser.send(message).await.is_err() {
                break;
            }
        }
        let _ = to_browser.close().await;
    };
    let down = async {
        while let Some(Ok(message)) = from_browser.next().await {
            let message = match message {
                BrowserMessage::Text(text) => ClientMessage::text(text.as_str()),
                BrowserMessage::Binary(bytes) => ClientMessage::binary(bytes),
                BrowserMessage::Ping(bytes) => ClientMessage::Ping(bytes),
                BrowserMessage::Pong(bytes) => ClientMessage::Pong(bytes),
                BrowserMessage::Close(_) | BrowserMessage::Frame(_) => break,
            };
            if to_client.send(message).await.is_err() {
                break;
            }
        }
        let _ = to_client.close().await;
    };
    // Either side closing ends the other.
    tokio::select! {
        () = up => {}
        () = down => {}
    }
}

/// The browser's HTTP discovery routes. The browser names its own address in the WebSocket
/// URLs it lists, which a client could not reach, or not with the executor's say; they are
/// rewritten to this route.
async fn discovery(
    State(sessions): State<Arc<Sessions>>,
    Path(parameters): Path<Vec<String>>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let id = &parameters[0];
    let cdp = match sessions.cdp(id).await {
        Ok(cdp) => cdp,
        Err(err) => return refuse(err),
    };
    let prefix = path(id);
    let rest = uri
        .path_and_query()
        .map_or("", |rest| rest.as_str())
        .strip_prefix(&prefix)
        .unwrap_or("/json");
    let asked = async {
        let stream = UnixStream::connect(&cdp.socket).await?;
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
        tokio::spawn(connection);
        // The browser answers only those who call it by its own address.
        let request = Request::builder()
            .method(method)
            .uri(rest)
            .header(header::HOST, DEVTOOLS_AUTHORITY)
            .body(Body::empty())?;
        let response = sender.send_request(request).await?;
        let status = response.status();
        anyhow::Ok((status, response.into_body().collect().await?.to_bytes()))
    };
    let (status, body) = match asked.await {
        Ok(answered) => answered,
        Err(err) => return (StatusCode::BAD_GATEWAY, format!("{err:#}")).into_response(),
    };
    let host = headers
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
        .unwrap_or("localhost");
    let body = match std::str::from_utf8(&body) {
        Ok(text) => Bytes::from(text.replace(DEVTOOLS_AUTHORITY, &format!("{host}{prefix}"))),
        Err(_) => body,
    };
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=UTF-8")],
        body,
    )
        .into_response()
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
