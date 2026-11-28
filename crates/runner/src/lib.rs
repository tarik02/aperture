//! What the runner of one session and whoever starts it agree on: the spec the runner is
//! given, the status it reports, and where both are kept in the session's runtime directory.
//!
//! The runner knows nothing of sessions beyond its own, nor of where the directories it is
//! given come from.

pub mod options;
pub mod proxy;

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::LazyLock,
};

use serde::{Deserialize, Serialize};

pub use aperture_gateway::{
    ACCESS_HEADER, Access, Area, Cdp, DEVTOOLS_AUTHORITY, Live, NAME_HEADER, SUBJECT_HEADER,
    TAB_HEADER,
};

/// The version of Aperture this is, with the commit it was built from as build metadata
/// where what packed it said: `1.0.0+86bc786e`, `1.0.0+86bc786e-dirty`. Between releases
/// every build has the last release's version, and the commit alone tells them apart. It is
/// told by `APERTURE_COMMIT`, which a package sets in the programs' wrappers: given to the
/// compiler, every commit would build the programs again.
pub static VERSION: LazyLock<String> = LazyLock::new(|| {
    let version = env!("CARGO_PKG_VERSION");
    match std::env::var("APERTURE_COMMIT") {
        Ok(commit) if !commit.trim().is_empty() => {
            let commit = commit.trim();
            let dirty = commit.ends_with("-dirty");
            let sha: String = commit.chars().take(8).collect();
            format!("{version}+{sha}{}", if dirty { "-dirty" } else { "" })
        }
        _ => version.to_owned(),
    }
});

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
    /// What the runner keeps of the session from one run to the next.
    pub state_dir: PathBuf,
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
    #[serde(default)]
    pub network: Network,
    /// Arguments for the browser after the runner's own.
    pub browser_args: Vec<String>,
    #[serde(default)]
    pub features: Features,
    /// The largest file clients put into the session, in bytes; any size without.
    pub upload_most: Option<u64>,
    /// Whoever starts the session puts a storage state into it next: until that is in, the
    /// session says it is being restored, from its first moment.
    #[serde(default)]
    pub restoring: bool,
}

/// What network the browser has in its sandbox, besides its proxy, which is the session's
/// and holds what goes through it to the session's rules.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Network {
    #[serde(default)]
    pub tcp: Tcp,
    #[serde(default)]
    pub udp: Udp,
}

impl Network {
    /// Whether the browser has a network of its own that reaches out, rather than none
    /// but its proxy.
    pub fn reaches_out(self) -> bool {
        self != Self::default()
    }
}

/// Where the browser's TCP goes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum Tcp {
    /// Nowhere but through the proxy.
    #[default]
    Proxied,
    /// Out as well. Pages still load through the proxy, but nothing holds the browser to
    /// it: what goes around it reaches the local network too.
    Direct,
}

/// Where the browser's UDP goes. A proxy carries none.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum Udp {
    /// Nowhere: WebRTC and whatever else takes UDP has no way out.
    #[default]
    None,
    /// Out, held to nothing: it reaches the local network too.
    Direct,
}

/// One of the things a session offers besides its picture and input.
// A name of two words would be `two-words` to clap and `two_words` to serde: it is given
// one name for both then, with `#[value(name = …)]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    Sound,
    Uploads,
    Downloads,
    Recordings,
    Clipboard,
    Mcp,
    Cdp,
    Tunnel,
}

impl Feature {
    /// What it is called where sessions are started with it, and told of it.
    pub fn name(self) -> String {
        use clap::ValueEnum;
        self.to_possible_value()
            .map_or_else(String::new, |value| value.get_name().to_owned())
    }
}

/// What a session offers besides its picture and input. Each is off unless whoever starts
/// the session turns it on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Features {
    /// Its tabs are heard, and their sound goes into recordings.
    #[serde(default)]
    pub sound: bool,
    /// Clients put files into it, for pages that ask for some.
    #[serde(default)]
    pub uploads: bool,
    /// Its browser downloads files.
    #[serde(default)]
    pub downloads: bool,
    /// Its tabs are recorded, by clients and by automation.
    #[serde(default)]
    pub recordings: bool,
    /// What is copied in it reaches its clients, and what they copy reaches it.
    #[serde(default)]
    pub clipboard: bool,
    /// Its automation is served, at `/mcp`.
    #[serde(default)]
    pub mcp: bool,
    /// Its browser's DevTools endpoint is served, at `/cdp`.
    #[serde(default)]
    pub cdp: bool,
    /// Clients attach tunnels, for the connections its rules send through them.
    #[serde(default)]
    pub tunnel: bool,
}

impl Features {
    pub fn has(&self, feature: Feature) -> bool {
        match feature {
            Feature::Sound => self.sound,
            Feature::Uploads => self.uploads,
            Feature::Downloads => self.downloads,
            Feature::Recordings => self.recordings,
            Feature::Clipboard => self.clipboard,
            Feature::Mcp => self.mcp,
            Feature::Cdp => self.cdp,
            Feature::Tunnel => self.tunnel,
        }
    }

    pub fn set(&mut self, feature: Feature, on: bool) {
        *match feature {
            Feature::Sound => &mut self.sound,
            Feature::Uploads => &mut self.uploads,
            Feature::Downloads => &mut self.downloads,
            Feature::Recordings => &mut self.recordings,
            Feature::Clipboard => &mut self.clipboard,
            Feature::Mcp => &mut self.mcp,
            Feature::Cdp => &mut self.cdp,
            Feature::Tunnel => &mut self.tunnel,
        } = on;
    }
}

/// The size browser windows fill, in logical pixels, until one is given another.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    /// Pixels to a logical pixel.
    #[serde(default = "one")]
    pub scale: f64,
}

fn one() -> f64 {
    1.0
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
    /// The native messaging host of the session's extension, `aperture-native-host`.
    pub native_host: PathBuf,
    /// ffmpeg, which makes the edits of recordings; without it they are left raw.
    pub ffmpeg: Option<PathBuf>,
    /// `aperture-browser-shim`, which runs the browser inside its sandbox.
    pub browser_shim: PathBuf,
    /// pasta, which gives a browser a network of its own; needed for any [`Network`] but the proxied one.
    #[serde(default)]
    pub pasta: Option<PathBuf>,
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

/// The most a storage state that is put into a session takes.
pub const STATE_BYTES: usize = 64 * 1024 * 1024;

/// The picture of what a session showed last, in what its runner keeps of it.
pub const PREVIEW: &str = "preview.png";

/// The pictures of a session's tabs as it was last suspended, in what its runner keeps of
/// it: `<tab>.png` and `<tab>.icon` of each, and [`TABS_KEPT`] that tells of them. A session
/// suspended by an earlier runner has none, only its [`PREVIEW`].
pub const PREVIEWS: &str = "previews";

/// What tells of the pictures in [`PREVIEWS`], written there last.
pub const TABS_KEPT: &str = "tabs.json";

/// The tabs of a session as it was last suspended.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KeptTabs {
    /// The tab that was watched last, whose picture is the session's [`PREVIEW`].
    pub watched: Option<u32>,
    /// In the order they came to be.
    pub tabs: Vec<KeptTab>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeptTab {
    pub tab: u32,
    pub title: String,
    pub url: String,
    /// What kind of picture the tab's icon is; none where its page has none.
    pub icon: Option<String>,
    /// Its picture is kept: one that did not come in time is not.
    pub picture: bool,
}
