//! Runs one session: its compositor and, in a sandbox, the browser on it. It serves the
//! session to those who watch it, reports where the session is reached in the status file,
//! and stops the browser on SIGTERM.

mod automation;
mod cdp;
mod egress;
mod extension;
mod files;
mod live;
mod pages;
mod presence;
mod targets;

mod proto {
    connectrpc::include_generated!();
}

use std::{
    fs,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    process::{ExitCode, Stdio},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, bail};
use aperture_runner::{
    Cdp, DEVTOOLS_AUTHORITY, Live, Phase, Spec, Status, lock_path, spec_path, write_status,
};
use futures_util::SinkExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    signal::unix::{SignalKind, signal},
    time::{Instant, sleep, timeout},
};
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

const BROWSER_READY_WITHIN: Duration = Duration::from_secs(60);
const TARGET_READY_WITHIN: Duration = Duration::from_secs(30);
/// A browser asked to close writes its profile out first.
const BROWSER_CLOSE_WITHIN: Duration = Duration::from_secs(15);
const TERMINATE_WITHIN: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(50);

/// Host trees the browser loads its libraries, fonts, certificates and resolver
/// configuration from.
const SYSTEM_ROOTS: &[&str] = &[
    "/usr",
    "/lib",
    "/lib64",
    "/bin",
    "/etc",
    "/nix/store",
    "/var/cache/fontconfig",
];

/// Where a GPU's drivers are and what describes the device to them, for a browser that
/// draws on one.
const GPU_ROOTS: &[&str] = &["/run/opengl-driver", "/sys/dev/char", "/sys/devices"];

/// Ports on the loopback of the browser's sandbox, which is its own: the browser's proxy,
/// and where it serves DevTools.
const PROXY_PORT: u16 = 1080;
const DEVTOOLS_PORT: u16 = 9222;

/// The profile, as the browser sees it.
const PROFILE: &str = "/profile";
const FILES: &str = "/files";

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
    let [runtime_dir] = &arguments[..] else {
        eprintln!("usage: aperture-runner RUNTIME_DIR");
        return Ok(ExitCode::from(2));
    };
    let runtime_dir = PathBuf::from(runtime_dir);
    let spec: Spec = serde_json::from_slice(
        &fs::read(spec_path(&runtime_dir)).context("failed to read the spec")?,
    )
    .context("invalid spec")?;

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

    let outcome = run(&spec, &mut status).await;
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

async fn run(spec: &Spec, status: &mut Status) -> anyhow::Result<()> {
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;

    // The browser's runtime directory holds the sockets of the display and of the
    // extension's host and nothing else: it is all of the session's runtime directory that
    // the sandbox gets to see.
    let sockets = spec.runtime_dir.join("browser");
    let _ = fs::remove_dir_all(&sockets);
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
    let mut windows = compositor.windows();

    // The browser has no network: this is its one way out.
    let egress_socket = sockets.join("proxy.sock");
    let policy = egress::Policy::new(&spec.egress_allow)?;
    let egress = egress::Egress::new(policy, &spec.proxy)?;
    let tunnel_socket = spec.runtime_dir.join("tunnel.sock");
    let egress_tasks = [
        tokio::spawn({
            let (egress, socket) = (egress.clone(), egress_socket.clone());
            async move { egress.serve(&socket).await }
        }),
        tokio::spawn({
            let (egress, socket) = (egress.clone(), tunnel_socket.clone());
            async move { egress.serve_local(&socket).await }
        }),
    ];
    // What the sandbox shares with the outside to put its own sockets in.
    let shared = sockets.join("shared");
    fs::DirBuilder::new().mode(0o700).create(&shared)?;
    let devtools_socket = shared.join("devtools.sock");

    // Before the browser starts: its extension reports as soon as it runs.
    let extension_socket = sockets.join("extension.sock");
    let extension_dir = spec.runtime_dir.join("extension");
    extension::unpack(&extension_dir).context("failed to write the extension")?;
    let kept_tabs = spec.state_dir.join("tabs.json");
    let sound = live::sound::Sound::new();
    let registry = targets::Registry::bind(
        &extension_socket,
        compositor.clone(),
        kept_tabs,
        sound.clone(),
    )
    .context("failed to listen for the extension")?;
    let mut ready = registry.targets();

    let mut live = None;
    let mut recordings = None;

    let mut browser = start_browser(
        spec,
        &display,
        &extension_socket,
        &extension_dir,
        &egress_socket,
        &shared,
        compositor.render_node(),
    )?;
    let outcome = async {
        let cdp = tokio::select! {
            cdp = browser_endpoint(&devtools_socket) => cdp?,
            exit = browser.wait() => bail!("the browser exited while starting: {}", exit?),
            _ = terminate.recv() => return Ok(()),
            _ = interrupt.recv() => return Ok(()),
        };
        let devtools = cdp::connect(&cdp)
            .await
            .context("failed to connect to the browser")?;
        registry.attach(devtools.clone());
        let downloads = files::follow_downloads(devtools.clone(), &spec.files_dir)
            .await
            .context("failed to follow the browser's downloads")?;
        let pages = pages::Pages::follow(devtools.clone(), registry.targets());

        let streams = live::stream::Streams::new(compositor.clone());
        let recorder = live::record::Recordings::new(
            streams.clone(),
            compositor.clone(),
            devtools.clone(),
            registry.targets(),
            spec.files_dir.clone(),
            live::record::Editor {
                ffmpeg: spec.tools.ffmpeg.clone(),
                cache: spec.cache_dir.join("ffmpeg"),
            },
            sound.clone(),
        );
        recordings = Some(recorder.clone());
        let presence = presence::Presence::new(compositor.clone());
        let automation = Arc::new(automation::Automation::new(
            devtools,
            registry.targets(),
            recorder.clone(),
            spec.files_dir.clone(),
            &presence,
        ));
        let live_socket = spec.runtime_dir.join("live.sock");
        live = Some({
            let socket = live_socket.clone();
            let served = live::Live {
                compositor: compositor.clone(),
                streams,
                targets: registry.targets(),
                recordings: recorder,
                egress: egress.clone(),
                rtc_ports: spec.rtc_ports,
                downloads,
                pages,
                sound: sound.clone(),
                presence,
                files: spec.files_dir.clone(),
            };
            tokio::spawn(async move { live::serve(&socket, served, automation).await })
        });
        status.live = Some(Live {
            socket: live_socket,
            tunnel_socket: tunnel_socket.clone(),
        });
        // A session is running once there is a page to show.
        let first_target = async {
            while ready.borrow_and_update().is_empty() {
                if ready.changed().await.is_err() {
                    break;
                }
            }
        };
        tokio::select! {
            shown = timeout(TARGET_READY_WITHIN, first_target) => {
                shown.context("the browser's first page did not get a window of its own")?;
            }
            exit = browser.wait() => bail!("the browser exited while starting: {}", exit?),
            _ = terminate.recv() => return Ok(()),
            _ = interrupt.recv() => return Ok(()),
        }
        info!(session = %spec.session_id, "session running");
        status.cdp = Some(cdp.clone());
        status.phase = Phase::Running;
        write_status(&spec.runtime_dir, status)?;

        tokio::select! {
            exit = browser.wait() => bail!("the browser exited: {}", exit?),
            // The channel closes when the compositor's thread ends.
            _ = async { while windows.changed().await.is_ok() {} } => bail!("the compositor stopped"),
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }
        status.phase = Phase::Stopping;
        write_status(&spec.runtime_dir, status)?;
        // The tabs are kept as they are now, not as the browser takes them down.
        registry.freeze();
        // While the browser still shows what they record.
        if let Some(recordings) = &recordings {
            recordings.stop_all().await;
        }
        close_browser(&cdp, &mut browser).await;
        Ok(())
    }
    .await;

    stop(&mut browser, "browser").await;
    if let Some(live) = live {
        live.abort();
    }
    for task in egress_tasks {
        task.abort();
    }
    let _ = tokio::task::spawn_blocking(move || compositor.stop()).await;
    outcome
}

/// Starts the browser in its sandbox. The browser runs with `--no-sandbox`, so this one is
/// what stands between a compromised renderer and the other sessions: it sees its own
/// profile, cache and files, the sockets of the display, of the extension's host and of its
/// egress, and the host's system trees read only. Of `/run` it gets no more than those
/// sockets. It has no network but a loopback of its own: what it sends goes to the egress
/// socket, and its DevTools endpoint is reached through a socket in `shared` (see the
/// browser shim).
fn start_browser(
    spec: &Spec,
    display: &Path,
    extension_socket: &Path,
    extension: &Path,
    egress_socket: &Path,
    shared: &Path,
    render_node: Option<&Path>,
) -> anyhow::Result<Child> {
    let profile = &spec.profile;
    for name in [
        "SingletonLock",
        "SingletonSocket",
        "SingletonCookie",
        "DevToolsActivePort",
    ] {
        let _ = fs::remove_file(profile.upper.join(name));
    }
    let home = spec.cache_dir.join("home");
    for dir in [home.join(".cache"), home.join(".config")] {
        fs::create_dir_all(dir)?;
    }
    let sockets = display.parent().context("the display has no directory")?;

    // Chromium looks for native messaging hosts in its profile, and starts the host inside
    // the sandbox.
    let hosts = profile.upper.join("NativeMessagingHosts");
    fs::create_dir_all(&hosts)?;
    fs::write(
        hosts.join(format!("{}.json", extension::NATIVE_HOST)),
        serde_json::to_vec_pretty(&extension::native_host_manifest(&spec.tools.native_host))?,
    )?;

    let mut command = Command::new(&spec.tools.bwrap);
    command.args([
        "--die-with-parent",
        "--unshare-user-try",
        "--unshare-uts",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-net",
        "--clearenv",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/run",
    ]);
    for root in SYSTEM_ROOTS {
        if Path::new(root).exists() {
            command.args(["--ro-bind", root, root]);
        }
    }
    if Path::new("/run/systemd/resolve").exists() {
        command.args(["--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve"]);
    }
    if let Some(node) = render_node {
        // The device, and what tells its driver which GPU it is.
        command.arg("--dev-bind").arg(node).arg(node);
        for described in GPU_ROOTS {
            if Path::new(described).exists() {
                command.args(["--ro-bind", described, described]);
            }
        }
    }
    command.arg("--dir").arg(sockets);
    command
        .arg("--bind")
        .arg(display)
        .arg(display)
        .arg("--bind")
        .arg(extension_socket)
        .arg(extension_socket)
        .arg("--ro-bind")
        .arg(extension)
        .arg(extension)
        .arg("--ro-bind")
        .arg(&spec.tools.native_host)
        .arg(&spec.tools.native_host)
        .arg("--bind")
        .arg(egress_socket)
        .arg(egress_socket)
        .arg("--bind")
        .arg(shared)
        .arg(shared)
        .arg("--ro-bind")
        .arg(&spec.tools.browser_shim)
        .arg(&spec.tools.browser_shim);
    if profile.lowers.is_empty() {
        command.arg("--bind").arg(&profile.upper).arg(PROFILE);
    } else {
        // bwrap stacks them in the order given, the first at the bottom.
        for lower in &profile.lowers {
            command.arg("--overlay-src").arg(lower);
        }
        command
            .arg("--overlay")
            .arg(&profile.upper)
            .arg(&profile.work)
            .arg(PROFILE);
    }
    command
        .arg("--bind")
        .arg(&spec.cache_dir)
        .arg(&spec.cache_dir)
        .arg("--bind")
        .arg(&spec.files_dir)
        .arg(FILES)
        // Also where it is outside: the automation tools, which run there, name the files
        // a page is to upload by their paths.
        .arg("--bind")
        .arg(&spec.files_dir)
        .arg(&spec.files_dir)
        .args(["--setenv", "TMPDIR", "/tmp"])
        // File names are UTF-8: without a locale that says so the browser crashes on a
        // file it is handed whose name has more than ASCII.
        .args(["--setenv", "LC_ALL", "C.UTF-8"])
        .arg("--setenv")
        .arg("HOME")
        .arg(&home)
        .arg("--setenv")
        .arg("XDG_CACHE_HOME")
        .arg(home.join(".cache"))
        .arg("--setenv")
        .arg("XDG_CONFIG_HOME")
        .arg(home.join(".config"))
        .arg("--setenv")
        .arg("XDG_RUNTIME_DIR")
        .arg(sockets)
        .arg("--setenv")
        .arg("WAYLAND_DISPLAY")
        .arg(display)
        .args(["--setenv", "XDG_SESSION_TYPE", "wayland"])
        .arg("--setenv")
        .arg("APERTURE_EXTENSION_SOCKET")
        .arg(extension_socket)
        .arg("--")
        .arg(&spec.tools.browser_shim)
        .arg(PROXY_PORT.to_string())
        .arg(egress_socket)
        .arg(shared.join("devtools.sock"))
        .arg(DEVTOOLS_PORT.to_string())
        .arg("--")
        .arg(&spec.tools.chromium)
        .arg(format!("--user-data-dir={PROFILE}"))
        .arg(format!("--disk-cache-dir={}", spec.cache_dir.display()))
        .arg(format!("--media-cache-dir={}", spec.cache_dir.display()))
        .arg(format!(
            "--disable-extensions-except={}",
            extension.display()
        ))
        .arg(format!("--load-extension={}", extension.display()))
        .args([
            "--remote-debugging-address=127.0.0.1",
            "--remote-allow-origins=*",
            // Everything goes to the proxy, also what names the sandbox's own loopback,
            // where the browser's DevTools endpoint is: a page has no business there.
            "--proxy-bypass-list=<-loopback>",
            // Datagrams have no way out.
            "--disable-quic",
            "--ozone-platform=wayland",
            // Fields take text as text, whatever keyboard it takes to write it.
            "--enable-wayland-ime",
            "--wayland-text-input-version=3",
            // No browser interface around the page, and none of the hints a fullscreen
            // window shows otherwise.
            "--kiosk",
            // The pages there were when the session last ran, with their histories.
            "--restore-last-session",
            // The browser would quit with its last window, and the extension closes the
            // window a page leaves for one of its own.
            "--keep-alive-for-test",
            "--no-sandbox",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-breakpad",
        ])
        .args(match render_node {
            // The browser draws on the GPU the compositor draws on, and hands it its
            // pages as buffers there.
            Some(node) => vec![
                "--use-gl=angle".to_owned(),
                "--use-angle=gles-egl".to_owned(),
                format!("--render-node-override={}", node.display()),
                "--ignore-gpu-blocklist".to_owned(),
                "--enable-gpu-rasterization".to_owned(),
                "--enable-zero-copy".to_owned(),
            ],
            None => vec![
                "--use-gl=angle".to_owned(),
                "--use-angle=swiftshader".to_owned(),
                "--enable-unsafe-swiftshader".to_owned(),
            ],
        })
        .arg(format!("--remote-debugging-port={DEVTOOLS_PORT}"))
        .arg(format!("--proxy-server=socks5://127.0.0.1:{PROXY_PORT}"))
        // An extension may tap a tab only once its user has pointed it at the tab, unless
        // it is named here.
        .arg(format!("--allowlisted-extension-id={}", extension::ID))
        .args(&spec.browser_args)
        .env_clear()
        .stdin(Stdio::null());
    own(&mut command, libc::SIGKILL);
    command.spawn().context("failed to start bwrap")
}

/// Waits for the browser to serve DevTools, and asks it for the path of the browser
/// target's WebSocket.
async fn browser_endpoint(socket: &Path) -> anyhow::Result<Cdp> {
    let deadline = Instant::now() + BROWSER_READY_WITHIN;
    loop {
        // Refused until the browser listens.
        if let Ok(version) = devtools_version(socket).await
            && let Some(url) = version["webSocketDebuggerUrl"].as_str()
            && let Some(at) = url.find("/devtools/")
        {
            return Ok(Cdp {
                socket: socket.to_owned(),
                browser_path: url[at..].to_owned(),
            });
        }
        if Instant::now() >= deadline {
            bail!("the browser did not open its DevTools endpoint in time");
        }
        sleep(POLL).await;
    }
}

/// What the browser says of itself at `/json/version`.
async fn devtools_version(socket: &Path) -> anyhow::Result<serde_json::Value> {
    let mut stream = tokio::net::UnixStream::connect(socket).await?;
    let request = format!(
        "GET /json/version HTTP/1.1\r\nHost: {DEVTOOLS_AUTHORITY}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;
    // The browser keeps the connection open, so the answer is read by its length.
    let mut response = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let read = stream.read(&mut chunk).await?;
        anyhow::ensure!(read > 0, "the browser's answer was cut short");
        response.extend_from_slice(&chunk[..read]);
        let Some(end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let head = std::str::from_utf8(&response[..end])?;
        anyhow::ensure!(head.starts_with("HTTP/1.1 200"), "the browser refused");
        let length: usize = head
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .context("the browser's answer has no length")?
            .1
            .trim()
            .parse()?;
        if let Some(body) = response.get(end + 4..end + 4 + length) {
            return Ok(serde_json::from_slice(body)?);
        }
    }
}

/// Asks the browser to close, which lets it write its profile out, and waits for it.
async fn close_browser(cdp: &Cdp, browser: &mut Child) {
    let asked = async {
        let mut socket = cdp::open(cdp, &cdp.browser_path).await?;
        socket
            .send(Message::text(r#"{"id":1,"method":"Browser.close"}"#))
            .await?;
        anyhow::Ok(browser.wait().await?)
    };
    match timeout(BROWSER_CLOSE_WITHIN, asked).await {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => warn!("failed to ask the browser to close: {err:#}"),
        Err(_) => warn!("the browser did not close in time"),
    }
}

/// Makes the child die with the runner, however the runner dies.
fn own(command: &mut Command, signal: libc::c_int) {
    // Safety: `prctl` is async-signal-safe, and nothing else runs between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, signal) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Terminates the child if it still runs, and kills it when that does not end it.
async fn stop(child: &mut Child, name: &str) {
    let Some(pid) = child.id() else {
        return;
    };
    // Safety: the child is not reaped yet, so the pid is still its own.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if timeout(TERMINATE_WITHIN, child.wait()).await.is_err() {
        warn!("the {name} did not stop in time; killing it");
        let _ = child.kill().await;
    }
}
