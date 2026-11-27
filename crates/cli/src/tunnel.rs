//! The far end of a session's tunnel, on this machine: connections the session routes
//! `via: local` are made from here, so a session reaches what this machine reaches, such
//! as a server on its localhost.

use std::{future::Future, net::SocketAddr, sync::Arc, time::Duration};

use anyhow::Context;
use aperture_tunnel::SUBPROTOCOL;
use reqwest::Method;
use rustls_platform_verifier::ConfigVerifierExt;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream,
    tungstenite::{
        self,
        client::IntoClientRequest,
        http::{HeaderValue, StatusCode, header},
    },
};
use tracing::{info, warn};

use crate::{
    config,
    control::{Control, Refused},
};

/// Attaches a tunnel to a session, and attaches it again whenever it ends, until
/// interrupted.
#[derive(clap::Args)]
#[command(args_conflicts_with_subcommands = true, subcommand_negates_reqs = true)]
pub struct Tunnel {
    #[command(subcommand)]
    listen: Option<Listen>,
    /// The session of the control plane logged in to.
    #[arg(required_unless_present = "url")]
    session: Option<String>,
    /// A session's tunnel endpoint itself, `ws://…/tunnel` or `wss://…/tunnel`, such as
    /// that of `aperture-runner serve`, in place of a session of the control plane.
    #[arg(long, conflicts_with = "session", requires = "token")]
    url: Option<String>,
    /// The token for `--url`: the session's, or an API token where it is reached through
    /// the control plane.
    #[arg(long, env = "APERTURE_TOKEN", hide_env_values = true)]
    token: Option<String>,
    #[command(flatten)]
    routes: Routes,
}

#[derive(clap::Subcommand)]
enum Listen {
    /// Serves tunnels that sessions dial, as the upstream `ws+yamux+socks5://ADDR/` of
    /// their routing.
    Listen {
        addr: SocketAddr,
        /// The secret sessions give as the upstream's `auth`.
        #[arg(long, env = "APERTURE_TUNNEL_AUTH", hide_env_values = true)]
        auth: String,
    },
}

#[derive(clap::Args, Clone, Default)]
pub struct Routes {
    /// Routes what the session's browser connects to at MATCH, `host` or `host:port`,
    /// through the tunnel while it is attached, and to TO, `host:port`, where it is given.
    /// The session's other rules stay behind these; a session reached by `--url` has its
    /// routing replaced, and emptied once the tunnel is no longer attached. May be repeated.
    #[arg(long = "route", value_name = "MATCH[=TO]", value_parser = route)]
    pub routes: Vec<Route>,
}

#[derive(Clone)]
pub struct Route {
    matched: String,
    to: Option<String>,
}

fn route(said: &str) -> Result<Route, String> {
    let (matched, to) = match said.split_once('=') {
        Some((matched, to)) => (matched, Some(to.to_owned())),
        None => (said, None),
    };
    if matched.is_empty() || to.as_deref() == Some("") {
        return Err(format!("{said:?} is no MATCH[=TO]"));
    }
    Ok(Route {
        matched: matched.to_owned(),
        to,
    })
}

impl Route {
    fn rule(&self) -> Value {
        let mut rule = json!({ "match": self.matched, "via": "local" });
        if let Some(to) = &self.to {
            rule["to"] = Value::String(to.clone());
        }
        rule
    }
}

pub async fn run(tunnel: Tunnel) -> anyhow::Result<()> {
    if let Some(Listen::Listen { addr, auth }) = tunnel.listen {
        return aperture_tunnel::listen(addr, &auth).await;
    }
    let interrupted = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    match (tunnel.url, tunnel.session) {
        (Some(url), _) => {
            let token = tunnel.token.context("--url takes --token")?;
            attach(
                &Target::Endpoint { url, token },
                &tunnel.routes.routes,
                interrupted,
            )
            .await
        }
        (None, Some(id)) => {
            let control = Control::new(config::read()?)?;
            let target = Target::Session {
                control: &control,
                id,
            };
            attach(&target, &tunnel.routes.routes, interrupted).await
        }
        (None, None) => unreachable!("the arguments take one of them"),
    }
}

/// Where a tunnel is attached.
pub enum Target<'a> {
    /// A session's tunnel endpoint itself.
    Endpoint { url: String, token: String },
    /// A session of a control plane, which is reached at the path it is at now: another
    /// once it moves.
    Session { control: &'a Control, id: String },
}

impl Target<'_> {
    /// Where the tunnel is attached now, and with what token; none while the session is
    /// on no node.
    async fn endpoint(&self) -> anyhow::Result<Option<(String, String)>> {
        match self {
            Target::Endpoint { url, token } => Ok(Some((url.clone(), token.clone()))),
            Target::Session { control, id } => {
                let session = control.get(&format!("/sessions/{id}")).await?;
                let Some(path) = session["path"].as_str() else {
                    return Ok(None);
                };
                let base = websocket(control.url());
                Ok(Some((
                    format!("{base}{path}/tunnel"),
                    control.token().to_owned(),
                )))
            }
        }
    }

    /// Puts `routes` before the session's own rules. Gives what to put back.
    async fn route(&self, routes: &[Route]) -> anyhow::Result<Value> {
        let rules: Vec<Value> = routes.iter().map(Route::rule).collect();
        match self {
            Target::Endpoint { url, token } => {
                put_endpoint_proxy(url, token, &json!({ "rules": rules })).await?;
                Ok(json!({}))
            }
            Target::Session { control, id } => {
                let path = format!("/sessions/{id}/proxy");
                let before = control.get(&path).await?["proxy"].take();
                let mut config = match &before {
                    Value::Object(_) => before.clone(),
                    _ => json!({}),
                };
                let kept = config["rules"].as_array().cloned().unwrap_or_default();
                config["rules"] = Value::Array(rules.into_iter().chain(kept).collect());
                control
                    .call(Method::PUT, &path, Some(&json!({ "proxy": config })))
                    .await?;
                Ok(before)
            }
        }
    }

    async fn unroute(&self, before: Value) -> anyhow::Result<()> {
        match self {
            Target::Endpoint { url, token } => put_endpoint_proxy(url, token, &before).await,
            Target::Session { control, id } => {
                let path = format!("/sessions/{id}/proxy");
                control
                    .call(Method::PUT, &path, Some(&json!({ "proxy": before })))
                    .await?;
                Ok(())
            }
        }
    }
}

/// Attaches the tunnel to `target`, with `routes` set while it is, and attaches it again
/// whenever it ends, until `stop` is done or the session refuses it.
pub async fn attach(
    target: &Target<'_>,
    routes: &[Route],
    stop: impl Future<Output = ()>,
) -> anyhow::Result<()> {
    let before = match routes.is_empty() {
        true => None,
        false => Some(
            target
                .route(routes)
                .await
                .context("failed to set the routes")?,
        ),
    };
    let kept = async {
        let mut wait = Duration::from_secs(1);
        loop {
            match target.endpoint().await {
                Ok(Some((url, token))) => match connect(&url, &token).await {
                    Ok(socket) => {
                        info!("attached: the session's connections via `local` are made from here");
                        wait = Duration::from_secs(1);
                        aperture_tunnel::serve(aperture_tunnel::bytes(socket)).await;
                        warn!("the tunnel ended; attaching it again");
                    }
                    Err(err) if for_good(&err) => return Err(err),
                    Err(err) => warn!("failed to attach: {err:#}"),
                },
                Ok(None) => info!("the session is on no node; waiting for it"),
                Err(err) if for_good(&err) => return Err(err),
                Err(err) => warn!("{err:#}"),
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(Duration::from_secs(30));
        }
    };
    let outcome = tokio::select! {
        outcome = kept => outcome,
        () = stop => Ok(()),
    };
    if let Some(before) = before
        && let Err(err) = target.unroute(before).await
    {
        warn!("failed to take the routes away: {err:#}");
    }
    outcome
}

/// Whether trying again changes nothing: the session is not there, takes no tunnels, or
/// not from this token.
fn for_good(err: &anyhow::Error) -> bool {
    let status = match (
        err.downcast_ref::<Refused>(),
        err.downcast_ref::<tungstenite::Error>(),
    ) {
        (Some(refused), _) => refused.status.as_u16(),
        (_, Some(tungstenite::Error::Http(response))) => response.status().as_u16(),
        _ => return false,
    };
    [
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::NOT_FOUND,
    ]
    .iter()
    .any(|refusal| refusal.as_u16() == status)
}

async fn connect(
    url: &str,
    token: &str,
) -> anyhow::Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    let mut request = url.into_client_request()?;
    let headers = request.headers_mut();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))?,
    );
    headers.insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(SUBPROTOCOL),
    );
    let tls = rustls::ClientConfig::with_platform_verifier()?;
    let (socket, _) = tokio_tungstenite::connect_async_tls_with_config(
        request,
        None,
        false,
        Some(Connector::Rustls(Arc::new(tls))),
    )
    .await?;
    Ok(socket)
}

/// The WebSocket address of what is served at `url`.
pub fn websocket(url: &str) -> String {
    match url.split_once("://") {
        Some(("https", rest)) => format!("wss://{rest}"),
        Some(("http", rest)) => format!("ws://{rest}"),
        _ => url.to_owned(),
    }
}

/// Sets the routing of the session whose tunnel endpoint is `url`, at its own `/proxy`.
async fn put_endpoint_proxy(url: &str, token: &str, config: &Value) -> anyhow::Result<()> {
    let session = url.strip_suffix("/tunnel").unwrap_or(url);
    let session = match session.split_once("://") {
        Some(("wss", rest)) => format!("https://{rest}"),
        Some(("ws", rest)) => format!("http://{rest}"),
        _ => session.to_owned(),
    };
    reqwest::Client::new()
        .put(format!("{session}/proxy"))
        .bearer_auth(token)
        .json(config)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}
