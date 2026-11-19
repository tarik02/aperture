//! What whoever starts sessions says of how they run: where the programs a session needs
//! are, and what its browser gets. The same options make a session's spec whether an
//! executor starts the session or it runs on its own.

use std::path::{Path, PathBuf};

use anyhow::Context;

use crate::{PortRange, Profile, Spec, Tools, Viewport, proxy};

/// What a session's windows fill until a client asks for another size.
const VIEWPORT: Viewport = Viewport {
    width: 1280,
    height: 720,
    scale: 1.0,
};

#[derive(clap::Args)]
pub struct Options {
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
    /// An argument for every session's browser. May be repeated.
    #[arg(long = "browser-arg", allow_hyphen_values = true)]
    browser_args: Vec<String>,
}

/// The options, with every program found.
#[derive(Clone)]
pub struct Setup {
    tools: Tools,
    rtc_ports: Option<PortRange>,
    cursor_theme: Option<PathBuf>,
    gpu: bool,
    egress_allow: Vec<String>,
    browser_args: Vec<String>,
}

/// Where a session's own directories are.
pub struct Directories {
    pub profile: Profile,
    pub cache: PathBuf,
    pub files: PathBuf,
    pub state: PathBuf,
}

impl Options {
    pub fn setup(self) -> anyhow::Result<Setup> {
        let beside = |given: Option<PathBuf>, name: &str| match given {
            Some(program) => executable(&program),
            None => executable(&own_sibling(name)?),
        };
        Ok(Setup {
            tools: Tools {
                bwrap: executable(&self.bwrap)?,
                chromium: executable(&self.chromium)?,
                native_host: beside(self.native_host, "aperture-native-host")?,
                browser_shim: beside(self.browser_shim, "aperture-browser-shim")?,
                ffmpeg: self.ffmpeg.as_deref().map(executable).transpose()?,
            },
            rtc_ports: self.rtc_ports,
            cursor_theme: self.cursor_theme,
            gpu: !self.no_gpu,
            egress_allow: self.egress_allow,
            browser_args: self.browser_args,
        })
    }
}

impl Setup {
    /// The spec of a session that runs with these options.
    pub fn spec(
        &self,
        session_id: &str,
        runtime_dir: PathBuf,
        directories: Directories,
        proxy: proxy::Config,
    ) -> Spec {
        Spec {
            session_id: session_id.to_owned(),
            runtime_dir,
            profile: directories.profile,
            cache_dir: directories.cache,
            files_dir: directories.files,
            state_dir: directories.state,
            tools: self.tools.clone(),
            viewport: VIEWPORT,
            rtc_ports: self.rtc_ports,
            cursor_theme: self.cursor_theme.clone(),
            gpu: self.gpu,
            egress_allow: self.egress_allow.clone(),
            proxy,
            browser_args: self.browser_args.clone(),
        }
    }
}

/// A program that is installed next to this one.
pub fn own_sibling(name: &str) -> anyhow::Result<PathBuf> {
    Ok(std::env::current_exe()
        .context("failed to find this program's own executable")?
        .with_file_name(name))
}

/// The program's absolute path, looked up in `PATH` when it is given by name: the browser
/// is started in a sandbox that has no `PATH`.
pub fn executable(program: &Path) -> anyhow::Result<PathBuf> {
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
