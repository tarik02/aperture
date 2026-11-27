//! A session on this machine: on Linux the release's runner, which this downloads, and
//! which downloads its own browser; elsewhere the session's image, in a container.

use std::{
    path::{Path, PathBuf},
    process::ExitCode,
    time::Duration,
};

use anyhow::Context;
use tokio::process::{Child, Command};
use tracing::{info, warn};

use crate::tunnel::{self, Routes, Target};

const IMAGE: &str = "ghcr.io/tarik02/aperture-session";
/// The container runtimes looked for, in this order.
const RUNTIMES: &[&str] = &["podman", "docker", "container"];

/// Runs a session on this machine and opens it, until interrupted.
#[derive(clap::Args)]
pub struct Run {
    /// Attach a tunnel to the session as well: what its browser connects to `via: local`
    /// is reached from this machine.
    #[arg(long)]
    tunnel: bool,
    #[command(flatten)]
    routes: Routes,
    /// Turns on something the session offers, as `aperture-runner serve --feature` takes
    /// it: `sound`, `uploads`, `downloads`, `recordings`, `clipboard`, `mcp`, `cdp`,
    /// `tunnel`. May be repeated.
    #[arg(long = "feature", value_delimiter = ',')]
    features: Vec<String>,
    /// The session's directory, kept from one run to the next. In a container a volume's
    /// name or a directory; `aperture-session` by default.
    #[arg(long)]
    data: Option<String>,
    /// The release that runs the session, or `nightly`. This program's own by default.
    #[arg(long, value_name = "VERSION")]
    runner_version: Option<String>,
    /// Run the session in a container where it could run here as well. Always so on
    /// macOS and Windows.
    #[arg(long)]
    container: bool,
    /// The container runtime: `podman`, `docker` or `container`. The first of them there
    /// is by default.
    #[arg(long)]
    runtime: Option<String>,
    /// The session's image. `ghcr.io/tarik02/aperture-session` of the release by default.
    #[arg(long)]
    image: Option<String>,
    /// Print the workbench's address, and open no browser at it.
    #[arg(long)]
    no_open: bool,
}

/// A session that was started, until it ends.
struct Started {
    child: Child,
    /// Where it is served, `host:port`.
    address: String,
    token: String,
    stop: Stop,
}

/// How a session is asked to stop.
enum Stop {
    /// Its processes, which are a group of their own.
    #[cfg(target_os = "linux")]
    Group,
    /// Its container.
    Container { runtime: String, name: String },
}

impl Started {
    async fn stop(&mut self) -> anyhow::Result<std::process::ExitStatus> {
        match &self.stop {
            #[cfg(target_os = "linux")]
            Stop::Group => {
                if let Some(pid) = self.child.id() {
                    // SAFETY: a signal to the group the child leads, which nothing else is in.
                    unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGTERM) };
                }
            }
            Stop::Container { runtime, name } => {
                let mut command = Command::new(runtime);
                command.arg("stop");
                if runtime_kind(runtime) != "container" {
                    command.args(["--time", "30"]);
                }
                let stopped = command.arg(name).status().await;
                if let Err(err) = stopped {
                    warn!("failed to stop the container {name}: {err}");
                }
            }
        }
        Ok(self.child.wait().await?)
    }
}

pub async fn run(run: Run) -> anyhow::Result<ExitCode> {
    let mut features = run.features.clone();
    let tunnel = run.tunnel || !run.routes.routes.is_empty();
    if tunnel && !features.iter().any(|feature| feature == "tunnel") {
        features.push("tunnel".to_owned());
    }
    let mut started = match run.container {
        #[cfg(target_os = "linux")]
        false => local(&run, &features).await?,
        _ => container(&run, &features).await?,
    };
    let url = format!("http://{}", started.address);

    let ready = tokio::select! {
        ready = ready(&mut started.child, &url, &started.token) => ready,
        () = interrupted() => return Ok(code(started.stop().await?)),
    };
    if let Err(err) = ready {
        let _ = started.stop().await;
        return Err(err);
    }
    let workbench = format!("{url}/?token={}", started.token);
    info!("the session is up");
    println!("{workbench}");
    if !run.no_open {
        open(&workbench);
    }

    let target = Target::Endpoint {
        url: format!("{}/tunnel", tunnel::websocket(&url)),
        token: started.token.clone(),
    };
    let attached = async {
        match tunnel {
            true => tunnel::attach(&target, &run.routes.routes, std::future::pending()).await,
            false => std::future::pending().await,
        }
    };
    tokio::select! {
        status = started.child.wait() => Ok(code(status?)),
        () = interrupted() => Ok(code(started.stop().await?)),
        attached = attached => {
            let _ = started.stop().await;
            attached.map(|()| ExitCode::FAILURE)
        }
    }
}

async fn interrupted() {
    let _ = tokio::signal::ctrl_c().await;
}

fn code(status: std::process::ExitStatus) -> ExitCode {
    match status.code() {
        Some(0) => ExitCode::SUCCESS,
        Some(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        None => ExitCode::FAILURE,
    }
}

/// Waits until the session answers, for as long as it runs.
async fn ready(child: &mut Child, url: &str, token: &str) -> anyhow::Result<()> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    loop {
        if let Some(status) = child.try_wait()? {
            anyhow::bail!("the session ended before it was up: {status}");
        }
        let answer = http
            .get(format!("{url}/targets"))
            .bearer_auth(token)
            .send()
            .await;
        if answer.is_ok_and(|answer| answer.status().is_success()) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// The release's runner, downloaded into the cache, serving a session at a port the
/// system chooses.
#[cfg(target_os = "linux")]
async fn local(run: &Run, features: &[String]) -> anyhow::Result<Started> {
    let client = aperture_release::client()?;
    let asked = run
        .runner_version
        .as_deref()
        .unwrap_or(aperture_release::VERSION);
    let version = aperture_release::resolve(&client, asked).await?;
    let bundle = aperture_release::cache_dir()?.join("runner").join(&version);
    let name = format!(
        "aperture-runner-{version}-linux-{}.tar.zst",
        aperture_release::arch()?
    );
    aperture_release::unpack(&client, &version, &name, &bundle).await?;

    let data = match &run.data {
        Some(data) => std::path::absolute(data)?,
        None => data_dir()?.join("session"),
    };
    std::fs::create_dir_all(&data).with_context(|| format!("failed to make {}", data.display()))?;
    let address_file = data.join("address");
    match std::fs::remove_file(&address_file) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err).context("failed to remove where an earlier run listened"),
    }
    let mut command = Command::new(bundle.join("bin/aperture-runner"));
    command
        .arg("serve")
        .arg("--data")
        .arg(&data)
        .args(["--listen", "127.0.0.1:0"]);
    for feature in features {
        command.arg("--feature").arg(feature);
    }
    // Interrupted, this asks the session to stop, which takes it a moment.
    command.process_group(0);
    let mut child = command.spawn().context("failed to start the runner")?;
    info!(data = %data.display(), "starting the session");

    let read = |path: &Path| {
        std::fs::read_to_string(path)
            .ok()
            .map(|read| read.trim().to_owned())
            .filter(|read| !read.is_empty())
    };
    let address = loop {
        if let Some(address) = read(&address_file) {
            break address;
        }
        if let Some(status) = child.try_wait()? {
            anyhow::bail!("the runner ended: {status}");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let token = read(&data.join("token")).context("the runner wrote no token")?;
    Ok(Started {
        child,
        address,
        token,
        stop: Stop::Group,
    })
}

/// The session's image in a container, published on this machine's loopback.
async fn container(run: &Run, features: &[String]) -> anyhow::Result<Started> {
    let runtime = match &run.runtime {
        Some(runtime) => runtime.clone(),
        None => found_runtime().await?,
    };
    let kind = runtime_kind(&runtime);
    let image = match (&run.image, run.runner_version.as_deref()) {
        (Some(image), _) => image.clone(),
        (None, None) => format!("{IMAGE}:{}", env!("CARGO_PKG_VERSION")),
        (None, Some(version)) => format!("{IMAGE}:{}", version.trim_start_matches('v')),
    };

    // The token is made here, so that it is known here: the image has no shell to read the
    // one a session makes with.
    let secrets = data_dir()?.join("container");
    std::fs::create_dir_all(&secrets)?;
    let token_file = secrets.join("token");
    let token = match std::fs::read_to_string(&token_file) {
        Ok(token) if !token.trim().is_empty() => token.trim().to_owned(),
        _ => {
            let token = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            std::io::Write::write_all(&mut options.open(&token_file)?, token.as_bytes())?;
            token
        }
    };

    let port = std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port();
    let name = format!("aperture-session-{port}");
    let data = match run.data.as_deref() {
        Some(data) if data.contains(['/', '\\']) => {
            std::path::absolute(data)?.display().to_string()
        }
        Some(volume) => volume.to_owned(),
        None => "aperture-session".to_owned(),
    };
    let mut command = Command::new(&runtime);
    command.args(["run", "--rm", "--name", &name]);
    // What lets the session's sandbox mount a `/proc` of its own, as docs/install.md says.
    match kind {
        "podman" => {
            command.args(["--security-opt", "unmask=ALL"]);
        }
        "docker" => {
            command.args([
                "--security-opt",
                "seccomp=unconfined",
                "--security-opt",
                "apparmor=unconfined",
                "--security-opt",
                "systempaths=unconfined",
            ]);
        }
        _ => {}
    }
    command
        .arg("--volume")
        .arg(format!("{data}:/data"))
        .arg("--volume")
        .arg(format!("{}:/secrets", secrets.display()))
        .args(["--env", "APERTURE_TOKEN_FILE=/secrets/token"])
        .arg("--publish")
        .arg(format!("127.0.0.1:{port}:7900"));
    if !features.is_empty() {
        command
            .arg("--env")
            .arg(format!("APERTURE_FEATURES={}", features.join(",")));
    }
    command.arg(&image);
    let child = command
        .spawn()
        .with_context(|| format!("failed to start {runtime}"))?;
    info!(%image, %runtime, "starting the session in a container");
    Ok(Started {
        child,
        address: format!("127.0.0.1:{port}"),
        token,
        stop: Stop::Container { runtime, name },
    })
}

/// Where sessions run here are kept.
fn data_dir() -> anyhow::Result<PathBuf> {
    let dir = dirs::data_dir().context("this system has no data directory")?;
    Ok(dir.join("aperture"))
}

/// Which of the known runtimes `runtime` is, by its name.
fn runtime_kind(runtime: &str) -> &'static str {
    let name = Path::new(runtime)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    RUNTIMES
        .iter()
        .find(|known| name.starts_with(*known))
        .copied()
        .unwrap_or("")
}

async fn found_runtime() -> anyhow::Result<String> {
    for runtime in RUNTIMES {
        let there = Command::new(runtime)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
        if there.is_ok_and(|status| status.success()) {
            return Ok((*runtime).to_owned());
        }
    }
    anyhow::bail!(
        "no container runtime found: install podman, docker or container, or name one with --runtime"
    )
}

/// Opens `url` in the browser of whoever runs this.
fn open(url: &str) {
    let mut command = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(windows) {
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    } else {
        std::process::Command::new("xdg-open")
    };
    let opened = command
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    if let Err(err) = opened {
        warn!("failed to open a browser: {err}");
    }
}
