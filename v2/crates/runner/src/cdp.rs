//! The runner's own connection to the browser's DevTools endpoint.

use std::collections::HashMap;

use anyhow::{Context, anyhow};
use aperture_runner::Cdp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

type Reply = oneshot::Sender<anyhow::Result<Value>>;

/// Commands to the browser target. Dropping every client closes the connection.
#[derive(Clone)]
pub struct Client {
    calls: mpsc::Sender<(&'static str, Value, Reply)>,
}

pub async fn connect(cdp: &Cdp) -> anyhow::Result<Client> {
    let url = format!("ws://127.0.0.1:{}{}", cdp.port, cdp.browser_path);
    let (socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .context("failed to connect to the browser")?;
    let (mut sink, mut stream) = socket.split();
    let (calls, mut called) = mpsc::channel::<(&'static str, Value, Reply)>(16);
    tokio::spawn(async move {
        let mut waiting: HashMap<u64, Reply> = HashMap::new();
        let mut next = 0;
        loop {
            tokio::select! {
                call = called.recv() => {
                    let Some((method, params, reply)) = call else {
                        return;
                    };
                    next += 1;
                    let message = json!({ "id": next, "method": method, "params": params });
                    if sink.send(Message::text(message.to_string())).await.is_err() {
                        return;
                    }
                    waiting.insert(next, reply);
                }
                message = stream.next() => {
                    let Some(Ok(message)) = message else {
                        // The browser is gone; those still waiting learn it from their
                        // dropped replies.
                        return;
                    };
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let Ok(mut message) = serde_json::from_str::<Value>(text.as_str()) else {
                        continue;
                    };
                    let Some(reply) = message["id"].as_u64().and_then(|id| waiting.remove(&id))
                    else {
                        continue;
                    };
                    let _ = reply.send(match message.get("error") {
                        Some(error) => Err(anyhow!("{}", error["message"].as_str().unwrap_or("failed"))),
                        None => Ok(message["result"].take()),
                    });
                }
            }
        }
    });
    Ok(Client { calls })
}

impl Client {
    pub async fn call(&self, method: &'static str, params: Value) -> anyhow::Result<Value> {
        let (reply, answer) = oneshot::channel();
        self.calls
            .send((method, params, reply))
            .await
            .map_err(|_| anyhow!("the browser is gone"))?;
        answer
            .await
            .map_err(|_| anyhow!("the browser is gone"))?
            .with_context(|| format!("{method} failed"))
    }
}
