// Service impls return concrete message types where the generated traits declare `impl Encodable`.
#![allow(refining_impl_trait_internal, refining_impl_trait_reachable)]

mod auth;
mod cdp;
mod limits;
mod live;
mod rpc;
mod scopes;
mod sessions;

mod proto {
    connectrpc::include_generated!();
}

use std::{
    fs,
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::Context;
use aperture_runner::{PortRange, Tools, Viewport};
use aperture_store::Store;
use axum::middleware;
use clap::Parser;
use jsonwebtoken::DecodingKey;
use tracing::info;

use crate::{
    limits::Limits,
    scopes::Scopes,
    sessions::{Config, Sessions},
};

/// What a session's windows fill until a client asks for another size.
const VIEWPORT: Viewport = Viewport {
    width: 1280,
    height: 720,
    scale: 1.0,
};

/// Runs browser sessions on this machine, for whoever holds its token.
#[derive(Parser)]
struct Arguments {
    #[arg(long, env = "APERTURE_LISTEN", default_value = "127.0.0.1:7900")]
    listen: SocketAddr,
    /// Sessions and snapshots are kept here. `$XDG_STATE_HOME/aperture` by default.
    #[arg(long, env = "APERTURE_DATA_DIR")]
    data_dir: Option<PathBuf>,
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
    /// The UDP ports WebRTC media uses, such as `60000-60999`, for a firewall that opens only
    /// some. Any port by default.
    #[arg(long, env = "APERTURE_RTC_PORTS", value_parser = port_range)]
    rtc_ports: Option<PortRange>,
    /// The cursor theme the pointer is drawn from in recordings, a directory with `cursors`
    /// in it.
    #[arg(long, env = "APERTURE_CURSOR_THEME")]
    cursor_theme: Option<PathBuf>,
    /// Draw sessions on the CPU also where a GPU works.
    #[arg(long, env = "APERTURE_NO_GPU")]
    no_gpu: bool,
    /// `aperture-runner`. Next to this program by default.
    #[arg(long, env = "APERTURE_RUNNER")]
    runner: Option<PathBuf>,
    #[arg(long, env = "APERTURE_BWRAP", default_value = "bwrap")]
    bwrap: PathBuf,
    #[arg(long, env = "APERTURE_CHROMIUM", default_value = "chromium")]
    chromium: PathBuf,
    /// A local address or network, such as `10.1.2.3` or `192.168.0.0/16`, that sessions'
    /// browsers may reach. What is local to this machine and its network is otherwise
    /// refused them. May be repeated.
    #[arg(
        long = "egress-allow",
        env = "APERTURE_EGRESS_ALLOW",
        value_delimiter = ','
    )]
    egress_allow: Vec<String>,
    /// `aperture-browser-shim`. Next to this program by default.
    #[arg(long, env = "APERTURE_BROWSER_SHIM")]
    browser_shim: Option<PathBuf>,
    /// ffmpeg, which makes the edits of recordings. Without it they are left raw.
    #[arg(long, env = "APERTURE_FFMPEG")]
    ffmpeg: Option<PathBuf>,
    /// `aperture-native-host`. Next to this program by default.
    #[arg(long, env = "APERTURE_NATIVE_HOST")]
    native_host: Option<PathBuf>,
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
    /// An argument for every session's browser. May be repeated.
    #[arg(long = "browser-arg", allow_hyphen_values = true)]
    browser_args: Vec<String>,
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
        None => std::env::current_exe()
            .context("failed to find the executor's own executable")?
            .with_file_name("aperture-runner"),
    };
    let native_host = match arguments.native_host {
        Some(host) => host,
        None => std::env::current_exe()
            .context("failed to find the executor's own executable")?
            .with_file_name("aperture-native-host"),
    };
    let browser_shim = match arguments.browser_shim {
        Some(shim) => shim,
        None => std::env::current_exe()
            .context("failed to find the executor's own executable")?
            .with_file_name("aperture-browser-shim"),
    };
    let store = Store::open(&data_dir)
        .with_context(|| format!("failed to open the store {}", data_dir.display()))?;
    let token = load_token(
        &arguments
            .token_file
            .unwrap_or_else(|| data_dir.join("token")),
    )?;
    let tickets = match &arguments.ticket_key {
        Some(key) => {
            let pem = std::fs::read(key)
                .with_context(|| format!("failed to read the ticket key {}", key.display()))?;
            Some(DecodingKey::from_ed_pem(&pem).context("the ticket key is no Ed25519 key")?)
        }
        None => None,
    };
    let keys = auth::Keys {
        token: Arc::from(token),
        tickets,
    };
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
            executable(&arguments.systemd_run)?,
            executable(&arguments.systemctl)?,
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
    let sessions = Arc::new(Sessions::new(
        store,
        Config {
            runtime_root,
            runner: executable(&runner)?,
            tools: Tools {
                bwrap: executable(&arguments.bwrap)?,
                chromium: executable(&arguments.chromium)?,
                native_host: executable(&native_host)?,
                browser_shim: executable(&browser_shim)?,
                ffmpeg: arguments.ffmpeg.as_deref().map(executable).transpose()?,
            },
            viewport: VIEWPORT,
            rtc_ports: arguments.rtc_ports,
            cursor_theme: arguments.cursor_theme,
            gpu: !arguments.no_gpu,
            egress_allow: arguments.egress_allow,
            browser_args: arguments.browser_args,
            limits,
            scopes,
        },
    ));
    tokio::spawn(sessions.clone().suspend_idle());

    let connect = connectrpc::Router::new().add_service(Arc::new(rpc::Executor(sessions.clone())));
    let app = cdp::router(sessions.clone())
        .merge(live::router(sessions))
        .fallback_service(connect.into_axum_service())
        .layer(middleware::from_fn_with_state(Arc::new(keys), auth::check));
    let listener = tokio::net::TcpListener::bind(arguments.listen)
        .await
        .with_context(|| format!("failed to listen on {}", arguments.listen))?;
    info!(listen = %arguments.listen, data = %data_dir.display(), "executor running");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

fn port_range(ports: &str) -> Result<PortRange, String> {
    let range = ports.split_once('-').and_then(|(first, last)| {
        Some(PortRange {
            first: first.trim().parse().ok()?,
            last: last.trim().parse().ok()?,
        })
    });
    range
        .filter(|range| range.first > 0 && range.first <= range.last)
        .ok_or_else(|| format!("{ports:?} is not a port range like 60000-60999"))
}

fn load_token(path: &Path) -> anyhow::Result<String> {
    if !path.exists() {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        fs::write(path, &token).with_context(|| format!("failed to write {}", path.display()))?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    let token = fs::read_to_string(path)
        .with_context(|| format!("failed to read the token {}", path.display()))?;
    let token = token.trim();
    anyhow::ensure!(!token.is_empty(), "the token {} is empty", path.display());
    Ok(token.to_owned())
}

fn xdg(variable: &str, fallback: &str) -> anyhow::Result<PathBuf> {
    match std::env::var_os(variable).filter(|dir| !dir.is_empty()) {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => {
            Ok(PathBuf::from(std::env::var_os("HOME").context("HOME is not set")?).join(fallback))
        }
    }
}

/// The program's absolute path, looked up in `PATH` when it is given by name: the browser
/// is started in a sandbox that has no `PATH`.
fn executable(program: &Path) -> anyhow::Result<PathBuf> {
    let found = if program.components().count() > 1 {
        program.canonicalize().ok()
    } else {
        std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join(program))
                .find(|candidate| candidate.is_file())
        })
    };
    found.with_context(|| format!("{} not found", program.display()))
}
