//! Tells a control plane that this node is there, for as long as it is.

use std::{sync::Arc, time::Duration};

use anyhow::Context;
use tracing::{info, warn};

use crate::proto::aperture::control::v1::{KeepaliveRequest, KeepaliveResponse};

/// How long the control plane has to answer a keepalive.
const ANSWERED_WITHIN: Duration = Duration::from_secs(10);
/// How long to wait before saying it again to a control plane that did not take it, or
/// that did not say how long to wait.
const AGAIN_AFTER: Duration = Duration::from_secs(5);
/// A control plane that asks for more than this is not heard: the node would be silent.
const AGAIN_AT_LEAST: Duration = Duration::from_millis(100);

/// What a node says of itself to its control plane.
pub struct Registration {
    /// The control plane's address, such as `https://aperture.example`.
    pub control_plane: String,
    pub registration_token: String,
    pub name: String,
    pub internal_url: String,
    pub balancer_url: Option<String>,
    pub public_url: Option<String>,
    pub operator_token: Arc<str>,
}

impl Registration {
    /// Says a keepalive, and again whenever the control plane asks for the next, for as
    /// long as the executor runs. A control plane that does not answer, or refuses, is
    /// asked again: it may come back, or be given the token it lacks.
    pub async fn keep(self) -> anyhow::Result<()> {
        let client = reqwest::Client::builder()
            .timeout(ANSWERED_WITHIN)
            .build()
            .context("failed to prepare requests to the control plane")?;
        let url = format!(
            "{}/aperture.control.v1.NodeService/Keepalive",
            self.control_plane.trim_end_matches('/')
        );
        let said = KeepaliveRequest {
            registration_token: self.registration_token,
            name: self.name,
            internal_url: self.internal_url,
            balancer_url: self.balancer_url,
            public_url: self.public_url,
            operator_token: self.operator_token.to_string(),
            ..Default::default()
        };
        // Told once each time it changes, and not with every keepalive.
        let mut kept = None;
        loop {
            let wait = match keepalive(&client, &url, &said).await {
                Ok(answer) => {
                    if kept != Some(true) {
                        info!(control_plane = %self.control_plane, node = %answer.node_id, "registered with the control plane");
                    }
                    kept = Some(true);
                    answer
                        .again_after
                        .as_option()
                        .and_then(|after| {
                            Duration::try_from_secs_f64(
                                after.seconds as f64 + f64::from(after.nanos) / 1e9,
                            )
                            .ok()
                        })
                        .unwrap_or(AGAIN_AFTER)
                        .max(AGAIN_AT_LEAST)
                }
                Err(error) => {
                    if kept != Some(false) {
                        warn!(control_plane = %self.control_plane, "the control plane does not keep this node: {error:#}");
                    }
                    kept = Some(false);
                    AGAIN_AFTER
                }
            };
            tokio::time::sleep(wait).await;
        }
    }
}

/// One call as Connect has a unary one: the request as JSON, and the answer in kind.
async fn keepalive(
    client: &reqwest::Client,
    url: &str,
    said: &KeepaliveRequest,
) -> anyhow::Result<KeepaliveResponse> {
    let answer = client.post(url).json(said).send().await?;
    let status = answer.status();
    if !status.is_success() {
        let why = answer.text().await.unwrap_or_default();
        anyhow::bail!("{status}: {why}");
    }
    answer
        .json()
        .await
        .context("the control plane's answer is not read")
}
