//! A running session's DevTools endpoint: the browser's WebSocket
//! at `/sessions/{id}/cdp`, and below it the browser's own discovery routes (`json/version`,
//! `json/list`, ...) and target WebSockets (`devtools/page/<id>`), so that a client given
//! the one URL finds the rest as it would on the browser's port.

use std::{path::PathBuf, sync::Arc};

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{
        OriginalUri, State, WebSocketUpgrade,
        ws::{Message as ClientMessage, WebSocket},
    },
    http::{HeaderMap, Method, Request, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use tokio::net::UnixStream;
use tokio_tungstenite::tungstenite::{Message as BrowserMessage, protocol::WebSocketConfig};

use crate::{DEVTOOLS_AUTHORITY, Sessions, Which};

pub fn router(sessions: Arc<dyn Sessions>) -> Router {
    Router::new()
        .route("/cdp", get(browser))
        .route("/cdp/devtools/{*target}", get(target))
        .route("/cdp/json", any(discovery))
        .route("/cdp/json/{*rest}", any(discovery))
        .with_state(sessions)
}

async fn browser(
    State(sessions): State<Arc<dyn Sessions>>,
    Which(id): Which,
    upgrade: WebSocketUpgrade,
) -> Response {
    match sessions.cdp(&id).await {
        Ok(cdp) => connect(upgrade, cdp.socket, cdp.browser_path, sessions.present(&id)).await,
        Err(refused) => refused.into_response(),
    }
}

async fn target(
    State(sessions): State<Arc<dyn Sessions>>,
    Which(id): Which,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Response {
    // `/cdp/devtools/...`, which is `/devtools/...` to the browser.
    let path = uri.path().strip_prefix("/cdp").unwrap_or_default();
    match sessions.cdp(&id).await {
        Ok(cdp) => connect(upgrade, cdp.socket, path.to_owned(), sessions.present(&id)).await,
        Err(refused) => refused.into_response(),
    }
}

/// Passes a client's WebSocket on to one of the browser's, which is reached before the
/// client is answered: a browser that does not answer is told as such.
///
/// CDP messages carry screenshots and whole documents, so neither side limits their size.
async fn connect(
    upgrade: WebSocketUpgrade,
    socket: PathBuf,
    path: String,
    here: Box<dyn Send>,
) -> Response {
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
    let browser = match connected.await {
        Ok(browser) => browser,
        Err(err) => {
            let reason = format!("failed to reach the browser: {err:#}");
            return (StatusCode::BAD_GATEWAY, reason).into_response();
        }
    };
    upgrade
        .max_message_size(usize::MAX)
        .max_frame_size(usize::MAX)
        .on_upgrade(move |client| async move {
            let _here = here;
            relay(client, browser).await;
        })
}

/// Passes messages both ways until either side closes or fails, which ends both.
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
/// URLs it lists, which a client could not reach, or not with the gateway's say; they are
/// rewritten to this route.
async fn discovery(
    State(sessions): State<Arc<dyn Sessions>>,
    Which(id): Which,
    OriginalUri(original): OriginalUri,
    uri: Uri,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let cdp = match sessions.cdp(&id).await {
        Ok(cdp) => cdp,
        Err(refused) => return refused.into_response(),
    };
    // Where the session is to whoever asks, which the paths here do not say.
    let prefix = original
        .path()
        .strip_suffix(uri.path())
        .unwrap_or_default()
        .to_owned()
        + "/cdp";
    let rest = uri
        .path_and_query()
        .map_or("", |rest| rest.as_str())
        .strip_prefix("/cdp")
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
