//! The runner's own connection to the browser's DevTools endpoint: commands to the browser
//! and, by session id, to the targets attached through it, and the events of all of them.

use std::collections::HashMap;

use aperture_runner::Cdp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};

/// Events buffered for a subscriber that falls behind; it then misses the oldest.
const EVENT_BUFFER: usize = 1024;

#[derive(Debug, Clone, thiserror::Error)]
pub enum Error {
    /// The browser refused the command.
    #[error("{0}")]
    Refused(String),
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

pub async fn connect(cdp: &Cdp) -> anyhow::Result<Client> {
    let url = format!("ws://127.0.0.1:{}{}", cdp.port, cdp.browser_path);
    // Messages carry screenshots and whole documents.
    let config = WebSocketConfig::default()
        .max_message_size(None)
        .max_frame_size(None);
    let (socket, _) = tokio_tungstenite::connect_async_with_config(url, Some(config), true).await?;
    let (mut sink, mut stream) = socket.split();
    let (calls, mut called) = mpsc::channel::<Call>(64);
    let (events, _) = broadcast::channel(EVENT_BUFFER);
    let published = events.clone();
    tokio::spawn(async move {
        let mut waiting: HashMap<u64, Reply> = HashMap::new();
        let mut next = 0;
        loop {
            tokio::select! {
                call = called.recv() => {
                    let Some(call) = call else {
                        return;
                    };
                    next += 1;
                    let mut message = json!({ "id": next, "method": call.method, "params": call.params });
                    if let Some(session) = call.session {
                        message["sessionId"] = session.into();
                    }
                    if sink.send(Message::text(message.to_string())).await.is_err() {
                        return;
                    }
                    waiting.insert(next, call.reply);
                }
                message = stream.next() => {
                    // When the browser is gone, those still waiting learn it from their
                    // dropped replies.
                    let Some(Ok(message)) = message else {
                        return;
                    };
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let Ok(mut message) = serde_json::from_str::<Value>(text.as_str()) else {
                        continue;
                    };
                    if let Some(id) = message["id"].as_u64() {
                        if let Some(reply) = waiting.remove(&id) {
                            let _ = reply.send(match message.get("error") {
                                Some(error) => Err(Error::Refused(
                                    error["message"].as_str().unwrap_or("failed").to_owned(),
                                )),
                                None => Ok(message["result"].take()),
                            });
                        }
                    } else if let Some(method) = message["method"].as_str() {
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

    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }
}
