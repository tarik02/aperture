//! Runs one session: its compositor and, in a sandbox, the browser on it. It serves the
//! session to those who watch it, reports where the session is reached in the status file,
//! and stops the browser on SIGTERM.

mod alone;
mod automation;
mod browser;
mod cdp;
mod certificates;
mod egress;
mod extension;
mod files;
mod live;
mod names;
mod pages;
mod presence;
mod targets;

mod proto {
    connectrpc::include_generated!();
}

use std::{
    fs, os::unix::fs::DirBuilderExt, path::Path, process::ExitCode, sync::Arc, time::Duration,
};

use anyhow::{Context, bail};
use aperture_runner::{Cdp, Live, Phase, Spec, Status, lock_path, spec_path, write_status};
use clap::Parser;
use tokio::{
    process::Child,
    signal::unix::{Signal, SignalKind, signal},
    task::JoinHandle,
    time::timeout,
};
use tracing::{info, warn};

use crate::{alone::Front, live::record::Recordings};

const TARGET_READY_WITHIN: Duration = Duration::from_secs(30);
/// How long the session's last picture may take: stopping does not wait on it for long.
const PREVIEW_WITHIN: Duration = Duration::from_secs(2);

// Children are told to die with the thread that started them (see `own`). `main`'s future
// runs on the main thread, the one that lives as long as the runner, so they are started
// from it and never from a spawned task.
#[tokio::main]
async fn main() -> anyhow::Result<ExitCode> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let (spec, front): (Spec, _) = match &arguments[..] {
        // Its own name is what the first argument stands for here.
        [first, ..] if first == "serve" => {
            let (spec, front) = alone::Serve::parse_from(&arguments).session()?;
            (spec, Some(front))
        }
        [runtime_dir] => {
            let spec =
                fs::read(spec_path(Path::new(runtime_dir))).context("failed to read the spec")?;
            (serde_json::from_slice(&spec).context("invalid spec")?, None)
        }
        _ => {
            eprintln!(
                "usage: aperture-runner RUNTIME_DIR\n       aperture-runner serve --data DIR"
            );
            return Ok(ExitCode::from(2));
        }
    };
    let runtime_dir = spec.runtime_dir.clone();

    // Held until the runner exits, see `aperture_runner::is_alive`. Whoever looks holds it
    // for an instant, hence the wait.
    let lock = fs::File::create(lock_path(&runtime_dir)).context("failed to create the lock")?;
    lock.lock()
        .context("failed to lock the runtime directory")?;

    let mut status = Status {
        phase: Phase::Starting,
        pid: std::process::id(),
        cdp: None,
        live: None,
        failure: None,
    };
    write_status(&runtime_dir, &status)?;

    let outcome = run(&spec, &mut status, front.as_ref()).await;
    status.cdp = None;
    status.live = None;
    let code = match outcome {
        Ok(()) => {
            status.phase = Phase::Stopped;
            ExitCode::SUCCESS
        }
        Err(err) => {
            warn!("session failed: {err:#}");
            status.phase = Phase::Failed;
            status.failure = Some(format!("{err:#}"));
            ExitCode::FAILURE
        }
    };
    write_status(&runtime_dir, &status)?;
    Ok(code)
}

/// The runner being told to stop.
struct Stop {
    terminate: Signal,
    interrupt: Signal,
}

impl Stop {
    fn new() -> std::io::Result<Self> {
        Ok(Self {
            terminate: signal(SignalKind::terminate())?,
            interrupt: signal(SignalKind::interrupt())?,
        })
    }

    async fn asked(&mut self) {
        tokio::select! {
            _ = self.terminate.recv() => {}
            _ = self.interrupt.recv() => {}
        }
    }
}

/// A service of the session, which ends with it and not before.
type Service = JoinHandle<std::io::Result<()>>;

/// What a session runs beside its browser, and what ends with it.
struct Session {
    compositor: aperture_compositor::Handle,
    egress: Arc<egress::Egress>,
    /// The browser's way out, where its names are answered, and the socket tunnels
    /// attach to.
    ways_out: [Service; 3],
    registry: targets::Registry,
    sound: Arc<live::sound::Sound>,
    /// From when the browser serves DevTools.
    live: Option<Service>,
    recordings: Option<Recordings>,
    /// Of a session that runs on its own.
    served: Option<JoinHandle<()>>,
}

async fn run(spec: &Spec, status: &mut Status, front: Option<&Front>) -> anyhow::Result<()> {
    let mut stop = Stop::new()?;

    // The browser's runtime directory holds the sockets of the display and of the
    // extension's host and nothing else: it is all of the session's runtime directory that
    // the sandbox gets to see.
    let sockets = spec.runtime_dir.join("browser");
    match fs::remove_dir_all(&sockets) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err).context("failed to clear the browser's runtime directory"),
    }
    fs::DirBuilder::new().mode(0o700).create(&sockets)?;
    let display = sockets.join("wayland-0");
    let compositor = aperture_compositor::start(aperture_compositor::Config {
        socket: display.clone(),
        viewport: aperture_compositor::Viewport {
            width: spec.viewport.width,
            height: spec.viewport.height,
            scale: spec.viewport.scale,
        },
        cursor_theme: spec.cursor_theme.clone(),
        gpu: spec.gpu,
        frame_layouts: if spec.gpu {
            live::frame_layouts()
        } else {
            Vec::new()
        },
    })
    .context("failed to start the compositor")?;

    // The browser has no network: this is its one way out.
    let egress_socket = sockets.join("proxy.sock");
    let policy = egress::Policy::new(&spec.egress_allow)?;
    let certificates = certificates::Certificates::new()?;
    let certificate_key = certificates.key_hash();
    let egress = egress::Egress::new(policy, &spec.proxy, certificates)?;
    let names_socket = sockets.join("names.sock");
    let ways_out = [
        tokio::spawn({
            let (egress, socket) = (egress.clone(), egress_socket.clone());
            async move { egress.serve(&socket).await }
        }),
        tokio::spawn({
            let (egress, socket) = (egress.clone(), names_socket.clone());
            async move { egress.serve_names(&socket).await }
        }),
        tokio::spawn({
            let (egress, socket) = (egress.clone(), tunnel_socket(spec));
            let tunnels = spec.features.tunnel;
            async move {
                if tunnels {
                    return egress.serve_local(&socket).await;
                }
                // Without the socket nobody attaches a tunnel: not one an earlier run
                // left either.
                match fs::remove_file(&socket) {
                    Ok(()) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => return Err(err),
                }
                std::future::pending().await
            }
        }),
    ];
    // The sandbox is given these sockets as it starts: they have to be there by then.
    for socket in [&egress_socket, &names_socket] {
        let bound = async {
            while !socket.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(5), bound)
            .await
            .with_context(|| format!("{} was not bound in time", socket.display()))?;
    }
    let shared = sockets.join("shared");
    fs::DirBuilder::new().mode(0o700).create(&shared)?;

    // Before the browser starts: its extension reports as soon as it runs.
    let extension_socket = sockets.join("extension.sock");
    let extension_dir = spec.runtime_dir.join("extension");
    extension::unpack(&extension_dir, spec.features.sound)
        .context("failed to write the extension")?;
    let sound = live::sound::Sound::new();
    let registry = targets::Registry::bind(
        &extension_socket,
        compositor.clone(),
        spec.state_dir.join("tabs.json"),
        sound.clone(),
    )
    .context("failed to listen for the extension")?;

    let given = browser::Given {
        display: &display,
        extension_socket: &extension_socket,
        extension: &extension_dir,
        egress_socket: &egress_socket,
        names_socket: &names_socket,
        certificate_key: &certificate_key,
        shared: &shared,
        render_node: compositor.render_node(),
    };
    let mut browser = browser::start(spec, &given)?;
    let devtools_socket = given.devtools_socket();
    let mut session = Session {
        compositor,
        egress,
        ways_out,
        registry,
        sound,
        live: None,
        recordings: None,
        served: None,
    };
    let outcome = session
        .serve(
            spec,
            status,
            front,
            &devtools_socket,
            &mut browser,
            &mut stop,
        )
        .await;

    browser::stop(&mut browser).await;
    session.end().await;
    outcome
}

fn tunnel_socket(spec: &Spec) -> std::path::PathBuf {
    spec.runtime_dir.join("tunnel.sock")
}

impl Session {
    /// Brings the session up once its browser serves DevTools, and keeps it until it is
    /// told to stop, which is how it ends well, or something of it ends by itself.
    async fn serve(
        &mut self,
        spec: &Spec,
        status: &mut Status,
        front: Option<&Front>,
        devtools_socket: &Path,
        browser: &mut Child,
        stop: &mut Stop,
    ) -> anyhow::Result<()> {
        let cdp = tokio::select! {
            cdp = browser::endpoint(devtools_socket) => cdp?,
            exit = browser.wait() => bail!("the browser exited while starting: {}", exit?),
            () = stop.asked() => return Ok(()),
        };
        let live = self.serve_live(spec, &cdp).await?;
        status.live = Some(live.clone());

        // A session is running once there is a page to show.
        let mut ready = self.registry.targets();
        let first_target = ready.wait_for(|targets| !targets.is_empty());
        tokio::select! {
            shown = timeout(TARGET_READY_WITHIN, first_target) => {
                shown
                    .context("the browser's first page did not get a window of its own")?
                    .context("the browser's targets are no longer followed")?;
            }
            exit = browser.wait() => bail!("the browser exited while starting: {}", exit?),
            () = stop.asked() => return Ok(()),
        }
        info!(session = %spec.session_id, "session running");
        // Whoever reads the status serves the endpoint to those who reach the session.
        status.cdp = spec.features.cdp.then(|| cdp.clone());
        status.phase = Phase::Running;
        write_status(&spec.runtime_dir, status)?;
        if let Some(front) = front {
            self.served = Some(front.serve(live, status.cdp.clone()).await?);
        }

        let [way_out, names, tunnels] = &mut self.ways_out;
        let services = [
            ("the browser's way out", Some(way_out)),
            ("the browser's names", Some(names)),
            ("the tunnel's socket", Some(tunnels)),
            ("the live endpoints", self.live.as_mut()),
        ];
        let mut windows = self.compositor.windows();
        tokio::select! {
            exit = browser.wait() => bail!("the browser exited: {}", exit?),
            failed = ended(services) => return Err(failed),
            // The channel closes when the compositor's thread ends.
            _ = async { while windows.changed().await.is_ok() {} } => bail!("the compositor stopped"),
            () = stop.asked() => {}
        }
        status.phase = Phase::Stopping;
        write_status(&spec.runtime_dir, status)?;
        // The tabs are kept as they are now, not as the browser takes them down.
        self.registry.freeze();
        self.keep_preview(spec).await;
        // While the browser still shows what they record.
        if let Some(recordings) = &self.recordings {
            recordings.stop_all().await;
        }
        browser::close(&cdp, browser).await;
        Ok(())
    }

    /// Keeps a small picture of what the session showed last, with what the runner keeps
    /// of it: a session at rest is known by it, on whichever node it is looked at.
    async fn keep_preview(&self, spec: &Spec) {
        let Some(window) = self
            .registry
            .targets()
            .borrow()
            .first()
            .map(|target| target.window)
        else {
            return;
        };
        let kept = async {
            let frame = timeout(PREVIEW_WITHIN, self.compositor.screenshot(window)).await??;
            let picture =
                tokio::task::spawn_blocking(move || live::shots::preview(&frame)).await??;
            tokio::fs::write(spec.state_dir.join(aperture_runner::PREVIEW), picture).await?;
            anyhow::Ok(())
        };
        if let Err(err) = kept.await {
            // The session is suspended all the same.
            warn!(session = %spec.session_id, "no picture of the session is kept: {err:#}");
        }
    }

    /// Connects to the browser and serves the session's live endpoints. Gives where they
    /// are reached.
    async fn serve_live(&mut self, spec: &Spec, cdp: &Cdp) -> anyhow::Result<Live> {
        let devtools = cdp::connect(cdp)
            .await
            .context("failed to connect to the browser")?;
        self.registry.attach(devtools.clone());
        let downloads =
            files::follow_downloads(devtools.clone(), &spec.files_dir, spec.features.downloads)
                .await
                .context("failed to follow the browser's downloads")?;
        let targets = || self.registry.targets();
        let pages = pages::Pages::follow(devtools.clone(), targets(), spec.features.uploads);

        let streams = live::stream::Streams::new(self.compositor.clone());
        let recordings = Recordings::new(
            live::record::Sources {
                streams: streams.clone(),
                compositor: self.compositor.clone(),
                browser: devtools.clone(),
                targets: targets(),
                sound: self.sound.clone(),
            },
            spec.files_dir.clone(),
            live::record::Editor {
                ffmpeg: spec.tools.ffmpeg.clone(),
                cache: spec.cache_dir.join("ffmpeg"),
            },
            spec.features.recordings,
        );
        let presence = presence::Presence::new(self.compositor.clone());
        let automation = Arc::new(automation::Automation::new(
            devtools.clone(),
            targets(),
            recordings.clone(),
            spec.files_dir.clone(),
            &presence,
        ));
        let served = live::Live {
            browser: devtools,
            compositor: self.compositor.clone(),
            streams,
            targets: targets(),
            recordings: recordings.clone(),
            egress: self.egress.clone(),
            rtc_ports: spec.rtc_ports,
            downloads,
            pages,
            sound: self.sound.clone(),
            presence,
            files: spec.files_dir.clone(),
            features: spec.features,
        };
        self.recordings = Some(recordings);
        let socket = spec.runtime_dir.join("live.sock");
        self.live = Some(tokio::spawn({
            let socket = socket.clone();
            async move { live::serve(&socket, served, automation).await }
        }));
        Ok(Live {
            socket,
            tunnel_socket: tunnel_socket(spec),
        })
    }

    async fn end(self) {
        for service in self.ways_out.into_iter().chain(self.live) {
            service.abort();
        }
        if let Some(served) = self.served {
            served.abort();
        }
        let compositor = self.compositor;
        if let Err(err) = tokio::task::spawn_blocking(move || compositor.stop()).await {
            warn!(%err, "the compositor did not stop well");
        }
    }
}

/// Waits for one of the session's own services to end, and tells which and why: none of
/// them ends while the session runs.
async fn ended<const N: usize>(services: [(&str, Option<&mut Service>); N]) -> anyhow::Error {
    let (names, tasks): (Vec<&str>, Vec<_>) = services
        .into_iter()
        .filter_map(|(name, task)| Some((name, task?)))
        .unzip();
    let (outcome, at, _) = futures_util::future::select_all(tasks).await;
    let name = names[at];
    match outcome {
        Ok(Ok(())) => anyhow::anyhow!("{name} stopped"),
        Ok(Err(err)) => anyhow::Error::from(err).context(format!("{name} failed")),
        Err(err) => anyhow::anyhow!("{name} failed: {err}"),
    }
}
