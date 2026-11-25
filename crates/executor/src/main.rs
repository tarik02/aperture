// Service impls return concrete message types where the generated traits declare `impl Encodable`.
#![allow(refining_impl_trait_internal, refining_impl_trait_reachable)]

mod asked;
mod limits;
mod metrics;
mod registration;
mod rpc;
mod scopes;
mod sessions;

mod proto {
    connectrpc::include_generated!();
}

use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use anyhow::Context;
use aperture_gateway::{Listen, Origin, auth::Keys};
use aperture_runner::options::{self, Options};
use aperture_store::{
    Store,
    remote::{Remote, Tools},
};
use axum::{
    Router,
    extract::Path,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use clap::Parser;
use tracing::{info, warn};

use crate::{
    limits::Limits,
    registration::Registration,
    scopes::Scopes,
    sessions::{Config, Door, Sessions},
};

/// Runs browser sessions on this machine, for whoever holds its token.
#[derive(Parser)]
#[command(version = aperture_runner::VERSION.as_str())]
struct Arguments {
    /// An address, or a Unix socket as `unix:PATH`.
    #[arg(long, env = "APERTURE_LISTEN", default_value = "127.0.0.1:7900")]
    listen: Listen,
    /// Leave out the page that shows a session, at `/sessions/<id>/`: sessions are shown
    /// by something else.
    #[arg(long, env = "APERTURE_NO_VIEWER")]
    no_viewer: bool,
    /// Where Prometheus metrics are served, at `/metrics`, such as `127.0.0.1:9464`: an
    /// address or a Unix socket, as `--listen` takes one, and another than that. They
    /// are answered to anyone who reaches them. None are served without it, or with it
    /// empty, as whatever names it whether or not it is wanted sets it.
    #[arg(long, env = "APERTURE_METRICS_LISTEN")]
    metrics_listen: Option<String>,
    /// Leave out of the metrics what each running session uses, labelled with its id:
    /// several series for every session that runs.
    #[arg(long, env = "APERTURE_METRICS_NO_PER_SESSION")]
    metrics_no_per_session: bool,
    /// Sessions and snapshots are kept here. `$XDG_STATE_HOME/aperture` by default.
    #[arg(long, env = "APERTURE_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// Where snapshots are kept for every node that names the same place: an S3 bucket
    /// as `s3://bucket/prefix`, with its region, endpoint and credentials in the usual
    /// `AWS_*` variables, or a directory the nodes share as `file:///directory`. A session
    /// is created from any snapshot there, and its layers are brought to this node when
    /// first needed. Without it snapshots are this node's alone.
    #[arg(long, env = "APERTURE_SNAPSHOT_STORE")]
    snapshot_store: Option<String>,
    /// Where sessions are kept for every node that names the same place, as
    /// `--snapshot-store` names one: a session is put there whenever it is suspended, and
    /// a node that is asked to resume one it does not have, or has an older state of,
    /// brings it from there. Nothing keeps two nodes from running one session: whoever
    /// tells the nodes what to do sees to that. Without it sessions are this node's alone.
    #[arg(long, env = "APERTURE_SESSION_STORE")]
    session_store: Option<String>,
    /// Say in the sessions' store which sessions this node has, and refuse to resume one
    /// another node says it has, unless asked to take it over. Takes a store that writes
    /// a file only if there is none, as S3 does.
    #[arg(long, env = "APERTURE_SESSION_LOCKS", requires = "session_store")]
    session_locks: bool,
    /// This node's name among those that share its stores. The machine's by default.
    #[arg(long, env = "APERTURE_NODE")]
    node: Option<String>,
    /// How many snapshots and sessions are on their way to or from the stores at a time.
    #[arg(long, env = "APERTURE_TRANSFERS", default_value_t = 4, value_parser = clap::value_parser!(u8).range(1..))]
    transfers: u8,
    /// tar and zstd, which pack what goes to those stores.
    #[arg(long, env = "APERTURE_TAR", default_value = "tar")]
    tar: PathBuf,
    #[arg(long, env = "APERTURE_ZSTD", default_value = "zstd")]
    zstd: PathBuf,
    /// Sockets and the state of running sessions. `$XDG_RUNTIME_DIR/aperture` by default.
    #[arg(long, env = "APERTURE_RUNTIME_DIR")]
    runtime_dir: Option<PathBuf>,
    /// The token requests carry. Generated into the data directory by default.
    #[arg(long, env = "APERTURE_TOKEN_FILE")]
    token_file: Option<PathBuf>,
    /// The public key tickets are signed with: Ed25519, as PEM. A ticket lets one person
    /// into one session; none are taken without a key.
    #[arg(long, env = "APERTURE_TICKET_KEY")]
    ticket_key: Option<PathBuf>,
    /// `aperture-runner`. Next to this program by default.
    #[arg(long, env = "APERTURE_RUNNER")]
    runner: Option<PathBuf>,
    /// Run each session as a systemd scope of its own, `aperture-session-<id>.scope` in
    /// `aperture-sessions.slice`: what a session uses is counted, it can be held to
    /// limits, and nothing of it outlives it. The scopes are those of the manager the
    /// executor runs under: its user's, or the system's for root.
    #[arg(long, env = "APERTURE_SESSION_SCOPES")]
    session_scopes: bool,
    #[arg(long, env = "APERTURE_SYSTEMD_RUN", default_value = "systemd-run")]
    systemd_run: PathBuf,
    #[arg(long, env = "APERTURE_SYSTEMCTL", default_value = "systemctl")]
    systemctl: PathBuf,
    /// The memory a session may use, such as `4G`, unless it has a limit of its own. A
    /// session that needs more loses a process, most likely a tab.
    #[arg(long, env = "APERTURE_SESSION_MEMORY", value_parser = limits::size)]
    session_memory: Option<u64>,
    /// The swap a session with a memory limit may use on top of it, such as `1G`, unless
    /// it has a limit of its own. Such a session uses none without this.
    #[arg(long, env = "APERTURE_SESSION_SWAP", value_parser = limits::size)]
    session_swap: Option<u64>,
    /// The processors' worth of time a session may use, such as `2` or `1.5`, unless it
    /// has a limit of its own. Takes `--session-scopes`, as the other limits do.
    #[arg(long, env = "APERTURE_SESSION_CPUS")]
    session_cpus: Option<f64>,
    /// The processes and threads a session may have, unless it has a limit of its own.
    #[arg(long, env = "APERTURE_SESSION_TASKS")]
    session_tasks: Option<u64>,
    /// How long nobody may use a session before it is suspended, such as `30m`, unless it
    /// has a time of its own. It is resumed when someone reaches it again. Sessions are
    /// left running without one.
    #[arg(long, env = "APERTURE_SUSPEND_IDLE_AFTER", value_parser = limits::stretch)]
    suspend_idle_after: Option<Duration>,
    /// An origin whose pages may reach the sessions from a browser, such as
    /// `https://app.example.com`, or `*` for any. A browser refuses the pages of every
    /// other origin but the executor's own. May be repeated.
    #[arg(
        long = "cors-origin",
        env = "APERTURE_CORS_ORIGINS",
        value_delimiter = ','
    )]
    cors_origins: Vec<Origin>,
    /// The control plane this node registers with, such as `https://aperture.example`:
    /// the node tells it that it is there, under its name, for as long as it runs, and
    /// gives it the operator's token, with which the control plane runs sessions here.
    #[arg(
        long,
        env = "APERTURE_CONTROL_PLANE",
        requires = "registration_token_file"
    )]
    control_plane: Option<String>,
    /// A file with a registration token, which an admin of the control plane makes.
    #[arg(
        long,
        env = "APERTURE_REGISTRATION_TOKEN_FILE",
        requires = "control_plane"
    )]
    registration_token_file: Option<PathBuf>,
    /// Where the control plane reaches this executor, such as `http://10.0.0.7:7900`.
    /// The address it listens on by default, where that is one others can reach.
    #[arg(long, env = "APERTURE_INTERNAL_URL", requires = "control_plane")]
    internal_url: Option<String>,
    /// Where a load balancer in front of the nodes reaches this one, when that is
    /// another address.
    #[arg(long, env = "APERTURE_BALANCER_URL", requires = "control_plane")]
    balancer_url: Option<String>,
    /// Where clients reach this node's sessions from outside, when they do.
    #[arg(long, env = "APERTURE_PUBLIC_URL", requires = "control_plane")]
    public_url: Option<String>,
    #[command(flatten)]
    options: Options,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let arguments = Arguments::parse();

    let data_dir = match arguments.data_dir {
        Some(dir) => dir,
        None => xdg("XDG_STATE_HOME", ".local/state")?.join("aperture"),
    };
    let runtime_root = match arguments.runtime_dir {
        Some(dir) => dir,
        None => match std::env::var_os("XDG_RUNTIME_DIR").filter(|dir| !dir.is_empty()) {
            Some(dir) => PathBuf::from(dir).join("aperture"),
            // Safety: no arguments, cannot fail.
            None => PathBuf::from(format!("/tmp/aperture-{}", unsafe { libc::getuid() })),
        },
    };
    let runner = match arguments.runner {
        Some(runner) => runner,
        None => options::own_sibling("aperture-runner")?,
    };
    let store = Store::open(&data_dir)
        .with_context(|| format!("failed to open the store {}", data_dir.display()))?;
    let keys = Keys::read(
        &arguments
            .token_file
            .unwrap_or_else(|| data_dir.join("token")),
        arguments.ticket_key.as_deref(),
        Box::new(|session| Some(sessions::path(session))),
    )?;
    let limits = Limits {
        memory: arguments.session_memory,
        swap: arguments.session_swap,
        cpus: arguments.session_cpus,
        tasks: arguments.session_tasks,
        idle_ms: arguments
            .suspend_idle_after
            .map(|after| after.as_millis() as u64),
    }
    .over(Limits::default());
    limits.check().map_err(anyhow::Error::msg)?;
    let scopes = if arguments.session_scopes {
        let scopes = Scopes::new(
            options::executable(&arguments.systemd_run)?,
            options::executable(&arguments.systemctl)?,
        )
        .await
        .context("sessions cannot run as scopes")?;
        info!("sessions run as scopes of their own");
        Some(scopes)
    } else {
        anyhow::ensure!(
            !limits.on_resources(),
            "limits on what sessions use take --session-scopes"
        );
        None
    };
    let shared = |url: &Option<String>, what: &'static str| {
        let Some(url) = url else {
            return Ok(None);
        };
        let tools = Tools {
            tar: options::executable(&arguments.tar)?,
            zstd: options::executable(&arguments.zstd)?,
        };
        anyhow::Ok(Some(Remote::open(url, tools).context(what)?))
    };
    let snapshots = shared(
        &arguments.snapshot_store,
        "failed to open the snapshots' store",
    )?;
    let shared_sessions = shared(
        &arguments.session_store,
        "failed to open the sessions' store",
    )?;
    let node = match arguments.node {
        Some(node) => node,
        None => fs::read_to_string("/proc/sys/kernel/hostname")
            .context("failed to read the machine's name")?
            .trim()
            .to_owned(),
    };
    let registration = match (arguments.control_plane, arguments.registration_token_file) {
        (Some(control_plane), Some(file)) => Some(Registration {
            control_plane,
            registration_token: fs::read_to_string(&file)
                .with_context(|| {
                    format!("failed to read the registration token {}", file.display())
                })?
                .trim()
                .to_owned(),
            name: node.clone(),
            internal_url: match (arguments.internal_url, &arguments.listen) {
                (Some(url), _) => url,
                (None, Listen::Address(address)) if !address.ip().is_unspecified() => {
                    format!("http://{address}")
                }
                (None, _) => anyhow::bail!(
                    "say where the control plane reaches this node, with --internal-url"
                ),
            },
            balancer_url: arguments.balancer_url,
            public_url: arguments.public_url,
            operator_token: keys.token.clone(),
        }),
        _ => None,
    };
    let sessions = Arc::new(Sessions::new(
        store,
        Config {
            snapshots,
            shared_sessions,
            holds_as: arguments.session_locks.then_some(node),
            transfers: arguments.transfers.into(),
            runtime_root,
            runner: options::executable(&runner)?,
            setup: arguments.options.setup()?,
            limits,
            scopes,
        },
    ));
    // Before anyone is told of the sessions: what the sweep stops is not told as running.
    sessions.sweep().await;
    tokio::spawn(sessions.clone().suspend_idle());
    let metrics_listen = arguments
        .metrics_listen
        .as_deref()
        .map(str::trim)
        .filter(|named| !named.is_empty())
        .map(str::parse::<Listen>)
        .transpose()
        .map_err(|reason| anyhow::anyhow!("--metrics-listen: {reason}"))?;
    if let Some(listen) = metrics_listen {
        let serving = metrics::Serving {
            listen,
            sessions: sessions.clone(),
            per_session: !arguments.metrics_no_per_session,
            data_dir: data_dir.clone(),
            registers: registration.is_some(),
        };
        let served = metrics::listen(serving).await?;
        tokio::spawn(async move {
            if let Err(error) = served.await {
                warn!("the metrics are served no more: {error}");
            }
        });
    }

    // A session is created with a storage state as large as its runner takes one, which
    // is more than a request is let be otherwise.
    let with_state = aperture_runner::STATE_BYTES + 1024 * 1024;
    let connect = connectrpc::Router::new()
        .add_service(Arc::new(rpc::Executor(sessions.clone())))
        .with_route_limits(
            "aperture.executor.v1.ExecutorService/CreateSession",
            connectrpc::Limits::default()
                .with_max_request_body_size(with_state)
                .with_max_message_size(with_state),
        );
    let shown = !arguments.no_viewer;
    let session = aperture_gateway::router(Arc::new(Door(sessions.clone())), shown);
    let previews = sessions.clone();
    let mut routes = Router::new()
        .route(
            &format!("{}/preview.png", sessions::path("{id}")),
            get(move |Path(id): Path<String>| async move { preview(&previews, &id) })
                .layer(axum::middleware::map_response(aperture_gateway::inert)),
        )
        .nest(&sessions::path("{id}"), session);
    if shown {
        // Routes mounted below a path are not at the path with a slash after it.
        let with_slash = format!("{}/", sessions::path("{id}"));
        routes = routes.route(&with_slash, get(async || aperture_gateway::viewer()));
    }
    let routes = routes.fallback_service(connect.into_axum_service());
    let app = aperture_gateway::guarded(routes, keys, &arguments.cors_origins)
        // For what stands before the node and what starts it: answered to anyone once the
        // node serves, and telling nothing.
        .route("/health", get(async || "ok"));
    let listening = arguments
        .listen
        .bind()
        .await
        .with_context(|| format!("failed to listen on {}", arguments.listen))?;
    info!(listen = %arguments.listen, data = %data_dir.display(), "executor running");
    if let Some(registration) = registration {
        tokio::spawn(async move {
            if let Err(error) = registration.keep().await {
                warn!("this node is not registered: {error:#}");
            }
        });
    }
    listening
        .serve(app, async {
            // Ended as a terminal ends it, or as whatever runs it as a service does.
            let terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate());
            match terminate {
                Ok(mut terminate) => {
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => {}
                        _ = terminate.recv() => {}
                    }
                }
                Err(_) => {
                    let _ = tokio::signal::ctrl_c().await;
                }
            }
        })
        .await?;
    Ok(())
}

/// The picture of a session at rest. It is served here and not by the session, which
/// answers only while it runs.
fn preview(sessions: &Sessions, id: &str) -> Response {
    match sessions.preview(id) {
        Ok(Some(picture)) => (
            [
                (header::CONTENT_TYPE, "image/png"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            picture,
        )
            .into_response(),
        Ok(None) | Err(sessions::Error::Store(_)) => StatusCode::NOT_FOUND.into_response(),
        Err(err) => {
            warn!(session = %id, "the session's picture is not read: {err}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

fn xdg(variable: &str, fallback: &str) -> anyhow::Result<PathBuf> {
    match std::env::var_os(variable).filter(|dir| !dir.is_empty()) {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => {
            Ok(PathBuf::from(std::env::var_os("HOME").context("HOME is not set")?).join(fallback))
        }
    }
}
