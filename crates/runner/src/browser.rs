//! The session's browser: Chromium in a sandbox of its own, from its start to its end.

use std::{fs, path::Path, process::Stdio, time::Duration};

use anyhow::Context;
use aperture_runner::{Cdp, DEVTOOLS_AUTHORITY, Spec, Tcp, Udp};
use futures_util::SinkExt;
use tokio::{
    process::{Child, Command},
    time::{Instant, sleep, timeout},
};
use tokio_tungstenite::tungstenite::Message;
use tracing::warn;

use crate::{cdp, extension};

const READY_WITHIN: Duration = Duration::from_secs(60);
/// A browser asked to close writes its profile out first.
const CLOSE_WITHIN: Duration = Duration::from_secs(15);
const TERMINATE_WITHIN: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(50);
/// How long one question to the endpoint may go unanswered. What takes it into the sandbox
/// accepts a connection before the browser listens, and one made then is never answered.
const ANSWERED_WITHIN: Duration = Duration::from_secs(2);

/// Host trees the browser loads its libraries, fonts, certificates and resolver
/// configuration from.
const SYSTEM_ROOTS: &[&str] = &[
    "/usr",
    "/lib",
    "/lib64",
    "/bin",
    "/nix/store",
    "/var/cache/fontconfig",
];

/// Where a browser looks under `/etc` for what its machine's owner has settled for it:
/// Chromium, and Chrome.
const POLICY_DIRS: &[&str] = &["chromium/policies/managed", "opt/chrome/policies/managed"];

/// What the browser is not to ask whoever uses a session, as none of it is theirs to keep
/// there: the browser keeps no passwords, addresses or cards and so does not offer to, it
/// translates nothing, signs in to nothing and tells of nothing of its own.
fn policy() -> serde_json::Value {
    serde_json::json!({
        "PasswordManagerEnabled": false,
        "PasswordLeakDetectionEnabled": false,
        "AutofillAddressEnabled": false,
        "AutofillCreditCardEnabled": false,
        "TranslateEnabled": false,
        "BrowserSignin": 0,
        "SyncDisabled": true,
        "DefaultBrowserSettingEnabled": false,
        "PromotionalTabsEnabled": false,
        "PrivacySandboxPromptEnabled": false,
        "MetricsReportingEnabled": false,
    })
}

/// Where a GPU's drivers are and what describes the device to them, for a browser that
/// draws on one.
const GPU_ROOTS: &[&str] = &["/run/opengl-driver", "/sys/dev/char", "/sys/devices"];

/// Ports on the loopback of the browser's sandbox, which is its own: the browser's proxy,
/// and where it serves DevTools.
const PROXY_PORT: u16 = 1080;
const DEVTOOLS_PORT: u16 = 9222;

/// Where a browser with a network of its own asks for names: its own loopback, where the
/// shim takes its questions to the session.
const NAMESERVER: &str = "127.0.0.1";

/// The profile, as the browser sees it.
const PROFILE: &str = "/profile";
const FILES: &str = "/files";

/// What is outside the sandbox that the browser is given in it.
pub struct Given<'a> {
    /// The compositor's socket. Its directory is the browser's runtime directory.
    pub display: &'a Path,
    /// Where the extension's host reports.
    pub extension_socket: &'a Path,
    /// The unpacked extension.
    pub extension: &'a Path,
    /// The browser's one way out.
    pub egress_socket: &'a Path,
    /// Where the session answers the names a browser with a network of its own asks for.
    pub names_socket: &'a Path,
    /// What names the key of the session's own certificates.
    pub certificate_key: &'a str,
    /// What the sandbox shares with the outside to put its own sockets in.
    pub shared: &'a Path,
    /// The GPU the compositor draws on, for a browser that draws on it too.
    pub render_node: Option<&'a Path>,
}

impl Given<'_> {
    /// Where the browser's DevTools endpoint is reached from outside.
    pub fn devtools_socket(&self) -> std::path::PathBuf {
        self.shared.join("devtools.sock")
    }
}

/// The directories of the session's files that are written from outside the sandbox: what
/// is recorded and what is shot. The browser reads them and writes neither, so nothing in
/// its sandbox puts a link where a recording or a picture is about to be written, which
/// would be written wherever the link points, with the reach of whoever runs the session.
const KEPT_FROM_OUTSIDE: [&str; 2] = ["recordings", "screenshots"];

/// Starts the browser in its sandbox. The browser runs with `--no-sandbox`, so this one is
/// what stands between a compromised renderer and the other sessions: it sees its own
/// profile, cache and files, the sockets of the display, of the extension's host and of its
/// egress, and the host's system trees read only. Of `/run` it gets no more than those
/// sockets. It has no network but a loopback of its own: what it sends goes to the egress
/// socket, and its DevTools endpoint is reached through a socket in `shared` (see the
/// browser shim).
pub fn start(spec: &Spec, given: &Given) -> anyhow::Result<Child> {
    let profile = &spec.profile;
    // What a browser that did not end well left, and takes for another one running.
    for name in [
        "SingletonLock",
        "SingletonSocket",
        "SingletonCookie",
        "DevToolsActivePort",
    ] {
        let left = profile.upper.join(name);
        match fs::remove_file(&left) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(err).with_context(|| format!("failed to remove {}", left.display()));
            }
        }
    }
    let home = spec.cache_dir.join("home");
    for dir in [home.join(".cache"), home.join(".config")] {
        fs::create_dir_all(dir)?;
    }

    // Chromium looks for native messaging hosts in its profile, and starts the host inside
    // the sandbox.
    let hosts = profile.upper.join("NativeMessagingHosts");
    fs::create_dir_all(&hosts)?;
    fs::write(
        hosts.join(format!("{}.json", extension::NATIVE_HOST)),
        serde_json::to_vec_pretty(&extension::native_host_manifest(&spec.tools.native_host))?,
    )?;

    let mut command = network(spec)?;
    sandbox(&mut command, spec, given, &home)?;
    command
        .arg("--")
        .arg(&spec.tools.browser_shim)
        .arg(PROXY_PORT.to_string())
        .arg(given.egress_socket)
        .arg(given.devtools_socket())
        .arg(DEVTOOLS_PORT.to_string())
        .args(spec.network.reaches_out().then_some(given.names_socket))
        .arg("--")
        .arg(&spec.tools.chromium)
        .args(arguments(spec, given))
        .env_clear()
        .stdin(Stdio::null());
    own(&mut command, libc::SIGKILL);
    command
        .spawn()
        .with_context(|| format!("failed to start {:?}", command.as_std().get_program()))
}

/// What runs bwrap: bwrap itself, for a browser with no network but its proxy, which
/// bwrap leaves it without; or pasta, which gives bwrap and what it runs a network of
/// their own that reaches out, with TCP, UDP or both. That network takes nothing in, and
/// the machine's own loopback is not in it. pasta makes the user namespace then, and the
/// shim may listen where names are asked for.
fn network(spec: &Spec) -> anyhow::Result<Command> {
    let bwrap = &spec.tools.bwrap;
    if !spec.network.reaches_out() {
        let mut command = Command::new(bwrap);
        command.args(["--unshare-net", "--unshare-user-try"]);
        return Ok(command);
    }
    let pasta = spec.tools.pasta.as_ref();
    let mut command = Command::new(pasta.context("a network of its own takes pasta")?);
    command.args(["--quiet", "--config-net"]);
    // The proxy is reached over a socket, so it takes none of this.
    if spec.network.tcp == Tcp::Proxied {
        command.arg("--no-tcp");
    }
    if spec.network.udp == Udp::None {
        command.arg("--no-udp");
    }
    command
        .args(["-t", "none", "-u", "none", "-T", "none", "-U", "none"])
        .args(["--map-host-loopback", "none"])
        .arg("--")
        .arg(bwrap)
        .args(["--cap-add", "CAP_NET_BIND_SERVICE"]);
    Ok(command)
}

/// bwrap's arguments, up to the command it runs in the sandbox.
fn sandbox(command: &mut Command, spec: &Spec, given: &Given, home: &Path) -> anyhow::Result<()> {
    let Given {
        display,
        extension_socket,
        extension,
        egress_socket,
        names_socket,
        shared,
        render_node,
        ..
    } = *given;
    let profile = &spec.profile;
    let sockets = display.parent().context("the display has no directory")?;
    command.args([
        "--die-with-parent",
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
    // The machine's `/etc` with the session's policy over it: the browser reads its policy
    // from there and from nowhere it can be pointed at.
    let etc = spec.runtime_dir.join("etc");
    for dir in POLICY_DIRS {
        let dir = etc.join(dir);
        fs::create_dir_all(&dir)?;
        fs::write(
            dir.join("aperture.json"),
            serde_json::to_vec_pretty(&policy())?,
        )?;
    }
    command
        .args(["--overlay-src", "/etc", "--overlay-src"])
        .arg(&etc)
        .args(["--ro-overlay", "/etc"]);
    if Path::new("/run/systemd/resolve").exists() {
        command.args(["--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve"]);
    }
    if spec.network.reaches_out() {
        // The machine's resolvers are not the session's, and are often on the machine's
        // loopback, which is not the browser's.
        let resolver = spec.runtime_dir.join("resolv.conf");
        fs::write(&resolver, format!("nameserver {NAMESERVER}\n"))?;
        let asked = fs::canonicalize("/etc/resolv.conf")
            .context("the machine names no resolver in /etc/resolv.conf")?;
        command.arg("--ro-bind").arg(resolver).arg(asked);
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
        .arg(names_socket)
        .arg(names_socket)
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
        .arg(&spec.files_dir);
    for kept in KEPT_FROM_OUTSIDE {
        let directory = spec.files_dir.join(kept);
        // A directory of this session's own making, whatever an earlier run of its
        // browser left under the name.
        match fs::symlink_metadata(&directory) {
            Ok(there) if there.is_dir() => {}
            Ok(_) => {
                fs::remove_file(&directory)?;
                fs::create_dir(&directory)?;
            }
            Err(_) => fs::create_dir_all(&directory)?,
        }
        for within in [Path::new(FILES), spec.files_dir.as_path()] {
            command
                .arg("--ro-bind")
                .arg(&directory)
                .arg(within.join(kept));
        }
    }
    command
        .args(["--setenv", "TMPDIR", "/tmp"])
        // File names are UTF-8: without a locale that says so the browser crashes on a
        // file it is handed whose name has more than ASCII.
        .args(["--setenv", "LC_ALL", "C.UTF-8"])
        .arg("--setenv")
        .arg("HOME")
        .arg(home)
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
        .arg(extension_socket);
    Ok(())
}

/// What Chromium is started with.
fn arguments(spec: &Spec, given: &Given) -> Vec<String> {
    let extension = given.extension.display();
    let cache = spec.cache_dir.display();
    let fixed = [
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
        // Nor does it ask which search engine to use, or whether to bring back the pages
        // of a session that did not end well, which it brings back anyway.
        "--disable-search-engine-choice-screen",
        "--hide-crash-restore-bubble",
        "--disable-breakpad",
        "--use-gl=angle",
    ];
    let drawn = match given.render_node {
        // The browser draws on the GPU the compositor draws on, and hands it its pages as
        // buffers there.
        Some(node) => vec![
            "--use-angle=gles-egl".to_owned(),
            format!("--render-node-override={}", node.display()),
            "--ignore-gpu-blocklist".to_owned(),
            "--enable-gpu-rasterization".to_owned(),
            "--enable-zero-copy".to_owned(),
        ],
        None => vec![
            "--use-angle=swiftshader".to_owned(),
            "--enable-unsafe-swiftshader".to_owned(),
        ],
    };
    let own = [
        format!("--user-data-dir={PROFILE}"),
        format!("--disk-cache-dir={cache}"),
        format!("--media-cache-dir={cache}"),
        format!("--disable-extensions-except={extension}"),
        format!("--load-extension={extension}"),
        format!("--remote-debugging-port={DEVTOOLS_PORT}"),
        format!("--proxy-server=socks5://127.0.0.1:{PROXY_PORT}"),
        // An extension may tap a tab only once its user has pointed it at the tab, unless
        // it is named here.
        format!("--allowlisted-extension-id={}", extension::ID),
        // The session's own certificates are good for any name, here and nowhere else.
        format!(
            "--ignore-certificate-errors-spki-list={}",
            given.certificate_key
        ),
    ];
    own.into_iter()
        .chain(fixed.map(str::to_owned))
        .chain(drawn)
        .chain(spec.browser_args.iter().cloned())
        .collect()
}

/// Waits for the browser to serve DevTools, and asks it for the path of the browser
/// target's WebSocket.
pub async fn endpoint(socket: &Path) -> anyhow::Result<Cdp> {
    let deadline = Instant::now() + READY_WITHIN;
    loop {
        // Refused until the browser listens.
        let said = aperture_gateway::ask_as(socket, DEVTOOLS_AUTHORITY, "/json/version");
        let said = match timeout(ANSWERED_WITHIN, said).await {
            Ok(said) => said,
            Err(_) => Err(anyhow::anyhow!("it did not answer")),
        };
        let refused = match said {
            Ok(version) => {
                let url = version["webSocketDebuggerUrl"].as_str();
                if let Some((url, at)) = url.and_then(|url| Some((url, url.find("/devtools/")?))) {
                    return Ok(Cdp {
                        socket: socket.to_owned(),
                        browser_path: url[at..].to_owned(),
                    });
                }
                anyhow::anyhow!("it names no browser target")
            }
            Err(err) => err,
        };
        if Instant::now() >= deadline {
            return Err(refused.context("the browser did not open its DevTools endpoint in time"));
        }
        sleep(POLL).await;
    }
}

/// Asks the browser to close, which lets it write its profile out, and waits for it.
pub async fn close(cdp: &Cdp, browser: &mut Child) {
    let asked = async {
        let mut socket = cdp::open(cdp, &cdp.browser_path).await?;
        socket
            .send(Message::text(r#"{"id":1,"method":"Browser.close"}"#))
            .await?;
        anyhow::Ok(browser.wait().await?)
    };
    match timeout(CLOSE_WITHIN, asked).await {
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

/// Terminates the browser if it still runs, and kills it when that does not end it.
pub async fn stop(browser: &mut Child) {
    let Some(pid) = browser.id() else {
        return;
    };
    // Safety: the child is not reaped yet, so the pid is still its own.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if timeout(TERMINATE_WITHIN, browser.wait()).await.is_err() {
        warn!("the browser did not stop in time; killing it");
        if let Err(err) = browser.kill().await {
            warn!(%err, "the browser was not killed");
        }
    }
}
