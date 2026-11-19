//! The runner's own connection to the browser's DevTools endpoint: commands to the browser
//! and, by session id, to the targets attached through it, and the events of all of them.

use std::collections::HashMap;

use aperture_runner::{Cdp, DEVTOOLS_AUTHORITY};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    net::UnixStream,
    sync::{broadcast, mpsc, oneshot},
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use tracing::warn;

/// Events buffered for a subscriber that falls behind; it then misses the oldest.
const EVENT_BUFFER: usize = 1024;

#[derive(Debug, Clone, thiserror::Error)]
pub enum Error {
    /// The browser refused the command.
    #[error("{0}")]
    Refused(String),
    /// The target the command was for ended before it answered.
    #[error("the target is gone")]
    Detached,
    #[error("the browser is gone")]
    Gone,
}

#[derive(Debug, Clone)]
pub struct Event {
    pub method: String,
    pub params: Value,
    /// The session the event came from; none for the browser's own.
    pub session: Option<String>,
}

type Reply = oneshot::Sender<Result<Value, Error>>;

struct Call {
    method: String,
    params: Value,
    session: Option<String>,
    reply: Reply,
}

/// Dropping every client closes the connection.
#[derive(Clone)]
pub struct Client {
    calls: mpsc::Sender<Call>,
    events: broadcast::Sender<Event>,
}

/// A WebSocket of the browser's DevTools endpoint, which is on a Unix socket.
pub async fn open(cdp: &Cdp, path: &str) -> anyhow::Result<WebSocketStream<UnixStream>> {
    let stream = UnixStream::connect(&cdp.socket).await?;
    // Messages carry screenshots and whole documents.
    let config = WebSocketConfig::default()
        .max_message_size(None)
        .max_frame_size(None);
    let url = format!("ws://{DEVTOOLS_AUTHORITY}{path}");
    let (socket, _) =
        tokio_tungstenite::client_async_with_config(url, stream, Some(config)).await?;
    Ok(socket)
}

pub async fn connect(cdp: &Cdp) -> anyhow::Result<Client> {
    let socket = open(cdp, &cdp.browser_path).await?;
    let (mut sink, mut stream) = socket.split();
    let (calls, mut called) = mpsc::channel::<Call>(64);
    let (events, _) = broadcast::channel(EVENT_BUFFER);
    let published = events.clone();
    tokio::spawn(async move {
        // The calls that have no answer yet, each with the session it was for.
        let mut waiting: HashMap<u64, (Option<String>, Reply)> = HashMap::new();
        let mut next = 0;
        loop {
            tokio::select! {
                call = called.recv() => {
                    let Some(call) = call else {
                        return;
                    };
                    next += 1;
                    let mut message = json!({ "id": next, "method": call.method, "params": call.params });
                    if let Some(session) = &call.session {
                        message["sessionId"] = session.as_str().into();
                    }
                    if let Err(err) = sink.send(Message::text(message.to_string())).await {
                        warn!("the browser's DevTools socket took no call: {err}");
                        return;
                    }
                    waiting.insert(next, (call.session, call.reply));
                }
                message = stream.next() => {
                    // When the browser is gone, those still waiting learn it from their
                    // dropped replies.
                    let message = match message {
                        Some(Ok(message)) => message,
                        Some(Err(err)) => {
                            warn!("the browser's DevTools socket failed: {err}");
                            return;
                        }
                        None => return,
                    };
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let mut message = match serde_json::from_str::<Value>(text.as_str()) {
                        Ok(message) => message,
                        Err(err) => {
                            warn!("the browser said what is no DevTools message: {err}");
                            continue;
                        }
                    };
                    if let Some(id) = message["id"].as_u64() {
                        if let Some((_, reply)) = waiting.remove(&id) {
                            // Whoever called may have stopped waiting.
                            let _ = reply.send(match message.get("error") {
                                Some(error) => Err(Error::Refused(
                                    error["message"].as_str().unwrap_or("failed").to_owned(),
                                )),
                                None => Ok(message["result"].take()),
                            });
                        }
                    } else if let Some(method) = message["method"].as_str() {
                        // The browser answers nothing more for a session that ended, not
                        // even that it did: whoever waits for it is told here.
                        if method == "Target.detachedFromTarget"
                            && let Some(ended) = message["params"]["sessionId"].as_str()
                        {
                            let of_ended =
                                |(session, _): &(Option<String>, Reply)| session.as_deref() == Some(ended);
                            for (_, (_, reply)) in waiting.extract_if(|_, call| of_ended(call)) {
                                let _ = reply.send(Err(Error::Detached));
                            }
                        }
                        // Nobody listening is fine.
                        let _ = published.send(Event {
                            method: method.to_owned(),
                            session: message["sessionId"].as_str().map(str::to_owned),
                            params: message["params"].take(),
                        });
                    }
                }
            }
        }
    });
    Ok(Client { calls, events })
}

impl Client {
    /// A command to the browser itself.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, Error> {
        self.call_in(None, method, params).await
    }

    /// A command to the target attached as `session`.
    pub async fn call_in(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, Error> {
        let (reply, answer) = oneshot::channel();
        let call = Call {
            method: method.to_owned(),
            params,
            session: session.map(str::to_owned),
            reply,
        };
        self.calls.send(call).await.map_err(|_| Error::Gone)?;
        answer.await.map_err(|_| Error::Gone)?
    }

    /// The events from now on.
    pub fn events(&self) -> Events {
        Events(self.events.subscribe())
    }
}

/// The events of the browser and of the targets attached through it, as they come.
pub struct Events(broadcast::Receiver<Event>);

impl Events {
    /// The next event; none once the browser is gone. A reader that fell behind missed
    /// the oldest, which is said: what follows the browser by its events may be wrong
    /// from then on.
    pub async fn next(&mut self) -> Option<Event> {
        loop {
            match self.0.recv().await {
                Ok(event) => return Some(event),
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    warn!(
                        missed,
                        "the browser's events came faster than they were read"
                    );
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}
