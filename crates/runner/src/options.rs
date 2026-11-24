//! What whoever starts sessions says of how they run: where the programs a session needs
//! are, and what its browser gets. The same options make a session's spec whether an
//! executor starts the session or it runs on its own.

use std::path::{Path, PathBuf};

use anyhow::Context;
use clap::ValueEnum;

use crate::{
    Feature, Features, Network, PortRange, Profile, Spec, Tcp, Tools, Udp, Viewport, proxy,
};

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
    /// Where the TCP of sessions' browsers goes. `proxied`: nowhere but through the
    /// session's proxy, which holds it to the session's rules. `direct`: out as well;
    /// pages still load through the proxy, but nothing holds a browser to it, and what
    /// goes around it reaches the local network too. Takes pasta.
    #[arg(long, env = "APERTURE_NETWORK_TCP", value_enum, default_value_t)]
    network_tcp: Tcp,
    /// Where the UDP of sessions' browsers goes, which a proxy does not carry. `none`:
    /// nowhere, so WebRTC has no way out. `direct`: out, held to nothing, the local
    /// network included. Takes pasta.
    #[arg(long, env = "APERTURE_NETWORK_UDP", value_enum, default_value_t)]
    network_udp: Udp,
    /// pasta, of the passt project, which gives browsers a network of their own.
    #[arg(long, env = "APERTURE_PASTA", default_value = "pasta")]
    pasta: PathBuf,
    /// `aperture-browser-shim`. Next to this program by default.
    #[arg(long, env = "APERTURE_BROWSER_SHIM")]
    browser_shim: Option<PathBuf>,
    /// ffmpeg, which makes the edits of recordings. Without it they are left raw.
    #[arg(long, env = "APERTURE_FFMPEG")]
    ffmpeg: Option<PathBuf>,
    /// `aperture-native-host`. Next to this program by default.
    #[arg(long, env = "APERTURE_NATIVE_HOST")]
    native_host: Option<PathBuf>,
    /// Turns on something sessions offer, or with `-` before its name turns it off: `sound`
    /// (tabs are heard), `uploads` (clients put files into sessions, for pages that ask for
    /// some), `downloads` (browsers download files), `recordings` (tabs are recorded and
    /// screenshots kept), `clipboard` (what is copied passes between sessions and their
    /// clients), `mcp` (the automation endpoint), `cdp` (the DevTools endpoint), `tunnel`
    /// (clients attach tunnels). All are off unless turned on; the last word on one counts. May be repeated: `--feature +sound --feature -uploads`.
    #[arg(
        long = "feature",
        env = "APERTURE_FEATURES",
        value_delimiter = ',',
        allow_hyphen_values = true,
        value_parser = feature
    )]
    features: Vec<(Feature, bool)>,
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
    network: Network,
    browser_args: Vec<String>,
    features: Features,
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
        let network = Network {
            tcp: self.network_tcp,
            udp: self.network_udp,
        };
        Ok(Setup {
            tools: Tools {
                bwrap: executable(&self.bwrap)?,
                chromium: executable(&self.chromium)?,
                native_host: beside(self.native_host, "aperture-native-host")?,
                browser_shim: beside(self.browser_shim, "aperture-browser-shim")?,
                ffmpeg: self.ffmpeg.as_deref().map(executable).transpose()?,
                pasta: match network.reaches_out() {
                    true => Some(named(&self.pasta)?),
                    false => None,
                },
            },
            network,
            rtc_ports: self.rtc_ports,
            cursor_theme: self.cursor_theme,
            gpu: !self.no_gpu,
            egress_allow: self.egress_allow,
            browser_args: self.browser_args,
            features: self.features.into_iter().fold(
                Features::default(),
                |mut features, (feature, on)| {
                    features.set(feature, on);
                    features
                },
            ),
        })
    }
}

impl Setup {
    /// What sessions offer, and no session more.
    pub fn features(&self) -> Features {
        self.features
    }

    /// The network sessions' browsers have, and no session's more.
    pub fn network(&self) -> Network {
        self.network
    }

    /// The spec of a session that runs with these options.
    pub fn spec(
        &self,
        session_id: &str,
        runtime_dir: PathBuf,
        directories: Directories,
        proxy: proxy::Config,
        features: Features,
        network: Network,
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
            network,
            browser_args: self.browser_args.clone(),
            features,
            restoring: false,
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
    if program.components().count() > 1 {
        return program
            .canonicalize()
            .with_context(|| format!("{} not found", program.display()));
    }
    let found = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(program))
            .find(|candidate| candidate.is_file())
    });
    found.with_context(|| format!("{} not found in PATH", program.display()))
}

/// The program's absolute path under the name it was given by, for one that goes by what
/// it is called as: pasta is passt under another name.
fn named(program: &Path) -> anyhow::Result<PathBuf> {
    if program.components().count() == 1 {
        return executable(program);
    }
    let path = std::path::absolute(program)?;
    anyhow::ensure!(path.is_file(), "{} not found", program.display());
    Ok(path)
}

fn feature(said: &str) -> Result<(Feature, bool), String> {
    let said = said.trim();
    let (name, on) = match said.strip_prefix('-') {
        Some(name) => (name, false),
        None => (said.strip_prefix('+').unwrap_or(said), true),
    };
    let feature = Feature::from_str(name, false).map_err(|_| {
        let names: Vec<_> = Feature::value_variants()
            .iter()
            .map(|feature| feature.name())
            .collect();
        format!("{name:?} is none of {}", names.join(", "))
    })?;
    Ok((feature, on))
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
