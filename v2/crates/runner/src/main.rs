//! Runs one session: its compositor and, in a sandbox, the browser on it. It serves the
//! session to those who watch it, reports where the session is reached in the status file,
//! and stops the browser on SIGTERM.

mod automation;
mod cdp;
mod live;
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
use aperture_runner::{Cdp, Live, Phase, Spec, Status, lock_path, spec_path, write_status};
use futures_util::SinkExt;
use tokio::{
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
        },
    })
    .context("failed to start the compositor")?;
    let mut windows = compositor.windows();

    // Before the browser starts: its extension reports as soon as it runs.
    let extension_socket = sockets.join("extension.sock");
    let registry = targets::Registry::bind(&extension_socket, compositor.clone())
        .context("failed to listen for the extension")?;
    let mut ready = registry.targets();

    let mut live = None;

    let mut browser = start_browser(spec, &display, &extension_socket)?;
    let outcome = async {
        let cdp = tokio::select! {
            cdp = browser_endpoint(&spec.profile.upper) => cdp?,
            exit = browser.wait() => bail!("the browser exited while starting: {}", exit?),
            _ = terminate.recv() => return Ok(()),
            _ = interrupt.recv() => return Ok(()),
        };
        let devtools = cdp::connect(&cdp)
            .await
            .context("failed to connect to the browser")?;
        registry.attach(devtools.clone());

        let automation = Arc::new(automation::Automation::new(
            devtools,
            compositor.clone(),
            registry.targets(),
            spec.files_dir.clone(),
        ));
        let live_socket = spec.runtime_dir.join("live.sock");
        live = Some({
            let socket = live_socket.clone();
            let compositor = compositor.clone();
            let targets = registry.targets();
            let rtc_ports = spec.rtc_ports;
            tokio::spawn(async move {
                live::serve(&socket, compositor, targets, automation, rtc_ports).await
            })
        });
        status.live = Some(Live {
            socket: live_socket,
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
        info!(session = %spec.session_id, cdp = cdp.port, "session running");
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
        close_browser(&cdp, &mut browser).await;
        Ok(())
    }
    .await;

    stop(&mut browser, "browser").await;
    if let Some(live) = live {
        live.abort();
    }
    outcome
}

/// Starts the browser in its sandbox. The browser runs with `--no-sandbox`, so this one is
/// what stands between a compromised renderer and the other sessions: it sees its own
/// profile, cache and files, the sockets of the display and of the extension's host, and the
/// host's system trees read only. Of `/run` it gets no more than those sockets.
fn start_browser(spec: &Spec, display: &Path, extension_socket: &Path) -> anyhow::Result<Child> {
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
        hosts.join(format!("{}.json", targets::NATIVE_HOST)),
        serde_json::to_vec_pretty(&targets::native_host_manifest(&spec.tools.native_host))?,
    )?;

    let mut command = Command::new(&spec.tools.bwrap);
    command.args([
        "--die-with-parent",
        "--unshare-user-try",
        "--unshare-uts",
        "--unshare-pid",
        "--unshare-ipc",
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
    command
        .arg("--dir")
        .arg(sockets)
        .arg("--bind")
        .arg(display)
        .arg(display)
        .arg("--bind")
        .arg(extension_socket)
        .arg(extension_socket)
        .arg("--ro-bind")
        .arg(&spec.tools.extension)
        .arg(&spec.tools.extension)
        .arg("--ro-bind")
        .arg(&spec.tools.native_host)
        .arg(&spec.tools.native_host);
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
        .arg(&spec.tools.chromium)
        .arg(format!("--user-data-dir={PROFILE}"))
        .arg(format!("--disk-cache-dir={}", spec.cache_dir.display()))
        .arg(format!("--media-cache-dir={}", spec.cache_dir.display()))
        .arg(format!(
            "--disable-extensions-except={}",
            spec.tools.extension.display()
        ))
        .arg(format!(
            "--load-extension={}",
            spec.tools.extension.display()
        ))
        .args([
            "--remote-debugging-address=127.0.0.1",
            // The browser picks the port and writes it into its profile, see
            // `browser_endpoint`.
            "--remote-debugging-port=0",
            "--remote-allow-origins=*",
            "--ozone-platform=wayland",
            // No browser interface around the page, and none of the hints a fullscreen
            // window shows otherwise.
            "--kiosk",
            // The browser would quit with its last window, and the extension closes the
            // window a page leaves for one of its own.
            "--keep-alive-for-test",
            // The sandbox has no GPU device, so the browser renders in software.
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--no-sandbox",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-breakpad",
        ])
        .args(&spec.browser_args)
        .env_clear()
        .stdin(Stdio::null());
    own(&mut command, libc::SIGKILL);
    command.spawn().context("failed to start bwrap")
}

/// Waits for the browser to say where its DevTools endpoint is: the port and the browser
/// target's path, on two lines of `DevToolsActivePort` in its profile. A file the browser
/// creates lands in the upper directory.
async fn browser_endpoint(upper: &Path) -> anyhow::Result<Cdp> {
    let path = upper.join("DevToolsActivePort");
    let deadline = Instant::now() + BROWSER_READY_WITHIN;
    loop {
        if let Ok(text) = fs::read_to_string(&path) {
            let mut lines = text.lines();
            if let (Some(port), Some(browser_path)) = (lines.next(), lines.next())
                && let Ok(port) = port.trim().parse()
            {
                return Ok(Cdp {
                    port,
                    browser_path: browser_path.trim().to_owned(),
                });
            }
        }
        if Instant::now() >= deadline {
            bail!("the browser did not open its DevTools endpoint in time");
        }
        sleep(POLL).await;
    }
}

/// Asks the browser to close, which lets it write its profile out, and waits for it.
async fn close_browser(cdp: &Cdp, browser: &mut Child) {
    let url = format!("ws://127.0.0.1:{}{}", cdp.port, cdp.browser_path);
    let asked = async {
        let (mut socket, _) = tokio_tungstenite::connect_async(url).await?;
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
