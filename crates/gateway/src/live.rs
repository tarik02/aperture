//! A running session's own endpoints: requests go on to the session, which serves them on
//! a socket of its own. The session's root answers with a page that shows it.

use std::{sync::Arc, time::SystemTime};

use axum::{
    Extension, Router,
    body::{Body, Bytes},
    extract::{RawPathParams, Request, State, WebSocketUpgrade, ws::Message},
    http::{StatusCode, Uri, header},
    response::{Html, IntoResponse, Response},
    routing::{delete, get},
};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    sync::broadcast,
};
use tracing::debug;

use crate::{ACCESS_HEADER, NAME_HEADER, SUBJECT_HEADER, Sessions, Which, auth::Caller};

/// A caller the operator dismissed from a session: the session's id, and the subject.
type Dismissed = (String, String);

/// Tells the session sockets that are open which callers are dismissed.
#[derive(Clone)]
struct Dismissals(broadcast::Sender<Dismissed>);

/// Dismissals waiting for a socket that is slow to hear of them. One that falls further
/// behind ends, as if it were dismissed: it cannot tell that it was not.
const DISMISSALS: usize = 64;

/// What a client is told its socket was closed for: nothing of the protocol is wrong.
const CLOSED_BY_POLICY: u16 = 1008;

pub fn router(sessions: Arc<dyn Sessions>) -> Router {
    Router::new()
        .route("/ws", get(session_socket))
        .route("/tunnel", get(tunnel))
        .route("/callers/{subject}", delete(dismiss))
        .fallback(forward)
        .layer(Extension(Dismissals(broadcast::channel(DISMISSALS).0)))
        .with_state(sessions)
}

/// Closes the session sockets of everyone who came into the session as `subject`: for
/// whoever signs tickets, when what it gave them for is taken back. It is the operator's
/// to ask, and a ticket that is still good lets its holder in again.
async fn dismiss(
    Which(id): Which,
    Extension(dismissals): Extension<Dismissals>,
    parameters: RawPathParams,
) -> StatusCode {
    let subject = parameters.iter().find(|(name, _)| *name == "subject");
    let Some((_, subject)) = subject else {
        return StatusCode::NOT_FOUND;
    };
    // Nobody listening is nobody to dismiss.
    let _ = dismissals.0.send((id, subject.to_owned()));
    StatusCode::NO_CONTENT
}

/// The workbench: the page that shows a session, which finds the session where the page
/// itself is. It tells nobody where it came from: its address may carry what let its
/// holder in.
pub fn viewer() -> Response {
    let told = [
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
    ];
    let page = Html(include_str!(concat!(env!("OUT_DIR"), "/workbench.html")));
    (told, page).into_response()
}

/// Whatever else is asked of a session is the session's own to answer.
async fn forward(
    State(sessions): State<Arc<dyn Sessions>>,
    Which(id): Which,
    request: Request,
) -> Response {
    // As the client wrote it: a path taken apart and put together again is another one
    // where it has escapes. What the client asks with goes on too, but for what let it in
    // here, which is nothing of the session's.
    let asked = request.uri().query().unwrap_or_default().split('&');
    let asked: Vec<&str> = asked
        .filter(|pair| {
            let name = pair.split_once('=').map_or(*pair, |(name, _)| name);
            !pair.is_empty() && name != "token" && name != "name"
        })
        .collect();
    let mut rest = request.uri().path().to_owned();
    if !asked.is_empty() {
        rest = format!("{rest}?{}", asked.join("&"));
    }
    forward_to(&*sessions, &id, &rest, request).await
}

/// Passes the request on to the session's runner, as a request for `path` there.
async fn forward_to(
    sessions: &dyn Sessions,
    id: &str,
    path: &str,
    mut request: Request,
) -> Response {
    let live = match sessions.live(id).await {
        Ok(live) => live,
        Err(refused) => return refused.into_response(),
    };
    // The session knows nothing of these paths or of tokens.
    *request.uri_mut() = match path.parse::<Uri>() {
        Ok(uri) => uri,
        Err(err) => return (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    };
    request.headers_mut().remove(header::AUTHORIZATION);
    match request.extensions().get::<Caller>().cloned() {
        Some(caller) => {
            if let Err(err) = caller.name_in(request.headers_mut()) {
                return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response();
            }
        }
        // Whoever mounted the routes lets anyone in: nobody is vouched for, whatever the
        // request says of itself.
        None => {
            for name in [SUBJECT_HEADER, NAME_HEADER, ACCESS_HEADER] {
                request.headers_mut().remove(name);
            }
        }
    }

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

/// A client's session socket: its messages go to the session's runner and back as they are.
async fn session_socket(
    State(sessions): State<Arc<dyn Sessions>>,
    Which(id): Which,
    Extension(caller): Extension<Caller>,
    Extension(dismissals): Extension<Dismissals>,
    upgrade: WebSocketUpgrade,
) -> Response {
    use tokio_tungstenite::tungstenite::{Message as RunnerMessage, client::IntoClientRequest};

    let live = match sessions.live(&id).await {
        Ok(live) => live,
        Err(refused) => return refused.into_response(),
    };
    let runner = async {
        let stream = UnixStream::connect(&live.socket).await?;
        let mut request = "ws://runner/ws".into_client_request()?;
        caller.name_in(request.headers_mut())?;
        let (runner, _) = tokio_tungstenite::client_async(request, stream).await?;
        anyhow::Ok(runner)
    };
    let runner = match runner.await {
        Ok(runner) => runner,
        Err(err) => return (StatusCode::BAD_GATEWAY, format!("{err:#}")).into_response(),
    };
    let here = sessions.present(&id);
    // Before the client is answered: one dismissed while it comes in is dismissed.
    let mut dismissed = dismissals.0.subscribe();
    let out = async move {
        let lapsed = async {
            match caller.until {
                Some(until) => {
                    let left = until.duration_since(SystemTime::now()).unwrap_or_default();
                    tokio::time::sleep(left).await;
                }
                None => std::future::pending().await,
            }
        };
        let dismissed = async {
            loop {
                match dismissed.recv().await {
                    Ok((session, subject)) if session == id && subject == caller.subject => break,
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => break,
                    Err(broadcast::error::RecvError::Closed) => std::future::pending().await,
                }
            }
        };
        tokio::select! {
            () = lapsed => "what let you in has run out",
            () = dismissed => "what let you in was taken back",
        }
    };
    upgrade.on_upgrade(move |client| async move {
        let _here = here;
        // A side that fails is done, as one that closes is.
        let (mut to_runner, mut from_runner) = runner.split();
        let (to_client, mut from_client) = client.split();
        // Two tell the client things: what the runner says, and why it is put out.
        let to_client = tokio::sync::Mutex::new(to_client);
        let up = async {
            while let Some(Ok(message)) = from_client.next().await {
                let message = match message {
                    Message::Binary(data) => RunnerMessage::Binary(data),
                    Message::Text(text) => RunnerMessage::Text(text.as_str().into()),
                    Message::Close(_) => break,
                    _ => continue,
                };
                if to_runner.send(message).await.is_err() {
                    break;
                }
            }
        };
        let down = async {
            while let Some(Ok(message)) = from_runner.next().await {
                let message = match message {
                    RunnerMessage::Binary(data) => Message::Binary(data),
                    RunnerMessage::Text(text) => Message::Text(text.as_str().into()),
                    // The runner's reason for closing is the client's to read.
                    RunnerMessage::Close(Some(frame)) => {
                        let frame = axum::extract::ws::CloseFrame {
                            code: frame.code.into(),
                            reason: frame.reason.as_str().into(),
                        };
                        // A client that is gone already reads no reason.
                        let _ = to_client
                            .lock()
                            .await
                            .send(Message::Close(Some(frame)))
                            .await;
                        break;
                    }
                    RunnerMessage::Close(None) => break,
                    _ => continue,
                };
                if to_client.lock().await.send(message).await.is_err() {
                    break;
                }
            }
        };
        // Either side ending ends the socket, and so does its caller being put out.
        tokio::select! {
            () = up => {}
            () = down => {}
            reason = out => {
                let frame = axum::extract::ws::CloseFrame {
                    code: CLOSED_BY_POLICY,
                    reason: reason.into(),
                };
                let _ = to_client.lock().await.send(Message::Close(Some(frame))).await;
            }
        }
    })
}

/// A client attaches the session's local tunnel: the WebSocket's binary messages are the
/// tunnel's bytes, passed to the runner and back as they are.
async fn tunnel(
    State(sessions): State<Arc<dyn Sessions>>,
    Which(id): Which,
    upgrade: WebSocketUpgrade,
) -> Response {
    let live = match sessions.live(&id).await {
        Ok(live) => live,
        Err(refused) => return refused.into_response(),
    };
    // Before the client is answered: a session that takes no tunnels has no socket for them.
    let runner = match UnixStream::connect(&live.tunnel_socket).await {
        Ok(runner) => runner,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return (StatusCode::NOT_FOUND, "the session takes no tunnels").into_response();
        }
        Err(err) => {
            let reason = format!("failed to reach the session's tunnel: {err}");
            return (StatusCode::BAD_GATEWAY, reason).into_response();
        }
    };
    let here = sessions.present(&id);
    upgrade
        .protocols([aperture_tunnel::SUBPROTOCOL])
        .on_upgrade(move |client| async move {
            let _here = here;
            // A side that fails is done, as one that closes is.
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

/// Asks the session's runner for something it says as JSON.
pub async fn ask(socket: &std::path::Path, path: &str) -> anyhow::Result<serde_json::Value> {
    ask_as(socket, "runner", path).await
}

/// Asks whoever serves HTTP on `socket` for something it says as JSON, as the host it
/// takes requests for.
pub async fn ask_as(
    socket: &std::path::Path,
    host: &str,
    path: &str,
) -> anyhow::Result<serde_json::Value> {
    let stream = UnixStream::connect(socket).await?;
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
    tokio::spawn(connection);
    let request = axum::http::Request::builder()
        .uri(path)
        .header(header::HOST, host)
        .body(Body::empty())?;
    let response = sender.send_request(request).await?;
    let status = response.status();
    let said = response.into_body().collect().await?.to_bytes();
    anyhow::ensure!(status.is_success(), "{}", String::from_utf8_lossy(&said));
    Ok(serde_json::from_slice(&said)?)
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
