//! What the runner of one session and whoever starts it agree on: the spec the runner is
//! given, the status it reports, and where both are kept in the session's runtime directory.
//!
//! The runner knows nothing of sessions beyond its own, nor of where the directories it is
//! given come from.

pub mod proxy;

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spec {
    pub session_id: String,
    /// Sockets, the status and the lock live here. The path must be short enough for the
    /// sockets below it (108 bytes).
    pub runtime_dir: PathBuf,
    pub profile: Profile,
    /// The browser's caches and home directory, which are not part of the profile.
    pub cache_dir: PathBuf,
    /// What the browser sees as `/files`: downloads and uploads.
    pub files_dir: PathBuf,
    pub tools: Tools,
    pub viewport: Viewport,
    /// The UDP ports WebRTC media uses, so a firewall needs to open only these; any port
    /// without.
    pub rtc_ports: Option<PortRange>,
    /// The cursor theme the pointer is drawn from in recordings, a directory with `cursors`
    /// in it.
    pub cursor_theme: Option<PathBuf>,
    /// Whether the session draws on a GPU where one works: its windows, and the browser
    /// its pages. On the CPU without.
    #[serde(default)]
    pub gpu: bool,
    /// Local addresses and networks the browser may reach; the rest of what is local to
    /// the node is refused it.
    pub egress_allow: Vec<String>,
    /// How the browser's connections are routed.
    #[serde(default)]
    pub proxy: proxy::Config,
    /// Arguments for the browser after the runner's own.
    pub browser_args: Vec<String>,
}

/// The size browser windows fill, in logical pixels.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

/// Ports from `first` to `last`, both included.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PortRange {
    pub first: u16,
    pub last: u16,
}

/// The browser's profile: `upper` over `lowers`, which are read only and listed lowest
/// first. `work` is overlayfs's own, on the filesystem of `upper`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub lowers: Vec<PathBuf>,
    pub upper: PathBuf,
    pub work: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tools {
    pub bwrap: PathBuf,
    pub chromium: PathBuf,
    /// The unpacked extension that keeps every page in a browser window of its own.
    pub extension: PathBuf,
    /// The extension's native messaging host, `aperture-native-host`.
    pub native_host: PathBuf,
    /// ffmpeg, which makes the edits of recordings; without it they are left raw.
    pub ffmpeg: Option<PathBuf>,
    /// `aperture-browser-shim`, which runs the browser inside its sandbox.
    pub browser_shim: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Status {
    pub phase: Phase,
    pub pid: u32,
    pub cdp: Option<Cdp>,
    pub live: Option<Live>,
    pub failure: Option<String>,
}

/// What the browser calls its DevTools endpoint: where it listens inside its sandbox. The
/// URLs it lists name it.
pub const DEVTOOLS_AUTHORITY: &str = "127.0.0.1:9222";

/// The browser's DevTools endpoint: HTTP and WebSockets on a Unix socket, as the browser
/// serves them on a port of its sandbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cdp {
    pub socket: PathBuf,
    /// The path of the browser target's WebSocket, `/devtools/browser/<id>`.
    pub browser_path: String,
}

/// Where the session is watched and controlled: the session socket, screenshots and the
/// rest, as HTTP on a socket. Whoever reaches the socket is trusted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Live {
    pub socket: PathBuf,
    /// Where a client's local tunnel is attached: a connection to this socket is the
    /// tunnel's bytes.
    pub tunnel_socket: PathBuf,
}

pub fn spec_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("spec.json")
}

pub fn status_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("status.json")
}

pub fn lock_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("runner.lock")
}

pub fn read_status(runtime_dir: &Path) -> io::Result<Option<Status>> {
    match fs::read(status_path(runtime_dir)) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// Through a rename, so a reader finds the old status or the new one.
pub fn write_status(runtime_dir: &Path, status: &Status) -> io::Result<()> {
    let path = status_path(runtime_dir);
    let staged = path.with_extension("json.tmp");
    fs::write(&staged, serde_json::to_vec_pretty(status)?)?;
    fs::rename(staged, path)
}

/// Whether a runner holds the runtime directory. The runner keeps an exclusive lock for as
/// long as it lives, which, unlike its pid, nothing else can come to hold.
pub fn is_alive(runtime_dir: &Path) -> io::Result<bool> {
    let file = match fs::File::open(lock_path(runtime_dir)) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };
    match file.try_lock_shared() {
        Ok(()) => Ok(false),
        Err(fs::TryLockError::WouldBlock) => Ok(true),
        Err(fs::TryLockError::Error(err)) => Err(err),
    }
}
