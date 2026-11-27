//! The control plane's API, as the token kept by `aperture login` reaches it.

use anyhow::Context;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

use crate::config::{self, Config};

/// What the control plane answered a request with, when it refused it.
#[derive(Debug, thiserror::Error)]
#[error("{status}: {said}")]
pub struct Refused {
    pub status: StatusCode,
    pub said: String,
}

pub struct Control {
    config: Config,
    http: reqwest::Client,
}

impl Control {
    pub fn new(config: Config) -> anyhow::Result<Self> {
        Ok(Self {
            config,
            http: reqwest::Client::builder().build()?,
        })
    }

    /// The control plane, `https://…`.
    pub fn url(&self) -> &str {
        &self.config.url
    }

    pub fn token(&self) -> &str {
        &self.config.token
    }

    /// Calls the API at `path`, below `/api/control`.
    pub async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> anyhow::Result<Value> {
        let url = format!("{}/api/control{path}", self.config.url);
        let mut request = self
            .http
            .request(method, &url)
            .bearer_auth(&self.config.token);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("failed to reach {}", self.config.url))?;
        let status = response.status();
        let text = response.text().await?;
        if !status.is_success() {
            let said = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|answer| answer["message"].as_str().map(str::to_owned))
                .unwrap_or(text);
            return Err(Refused { status, said }.into());
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).with_context(|| format!("{url} answered no JSON"))
    }

    pub async fn get(&self, path: &str) -> anyhow::Result<Value> {
        self.call(Method::GET, path, None).await
    }
}

#[derive(clap::Subcommand)]
pub enum Sessions {
    /// Lists them.
    #[command(alias = "list")]
    Ls,
    /// Makes one, and says its id.
    New {
        #[arg(long)]
        label: Option<String>,
        /// The snapshot it starts from.
        #[arg(long)]
        snapshot: Option<String>,
        /// The workspace it is of; the account's own without.
        #[arg(long)]
        workspace: Option<String>,
    },
    /// Deletes them.
    #[command(alias = "delete")]
    Rm {
        #[arg(required = true)]
        ids: Vec<String>,
    },
}

pub async fn sessions(command: Sessions) -> anyhow::Result<()> {
    let control = Control::new(config::read()?)?;
    match command {
        Sessions::Ls => {
            let sessions = control.get("/sessions").await?;
            let text = |value: &Value| value.as_str().unwrap_or("-").to_owned();
            let rows: Vec<[String; 4]> = sessions
                .as_array()
                .into_iter()
                .flatten()
                .map(|session| {
                    [
                        text(&session["id"]),
                        text(&session["observedState"]),
                        text(&session["nodeName"]),
                        text(&session["label"]),
                    ]
                })
                .collect();
            let widths = rows.iter().fold([2, 5, 4], |widths, row| {
                [0, 1, 2].map(|column| widths[column].max(row[column].len()))
            });
            println!(
                "{:<3$}  {:<4$}  {:<5$}  LABEL",
                "ID", "STATE", "NODE", widths[0], widths[1], widths[2]
            );
            for [id, state, node, label] in rows {
                println!(
                    "{id:<0$}  {state:<1$}  {node:<2$}  {label}",
                    widths[0], widths[1], widths[2]
                );
            }
        }
        Sessions::New {
            label,
            snapshot,
            workspace,
        } => {
            let mut asked = json!({});
            for (field, value) in [
                ("label", label),
                ("snapshotId", snapshot),
                ("workspaceId", workspace),
            ] {
                if let Some(value) = value {
                    asked[field] = Value::String(value);
                }
            }
            let session = control
                .call(Method::POST, "/sessions", Some(&asked))
                .await?;
            println!("{}", session["id"].as_str().unwrap_or_default());
        }
        Sessions::Rm { ids } => {
            for id in ids {
                control
                    .call(Method::DELETE, &format!("/sessions/{id}"), None)
                    .await
                    .with_context(|| format!("failed to delete {id}"))?;
            }
        }
    }
    Ok(())
}
