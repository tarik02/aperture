//! A systemd scope for each session: what holds a session to its limits, counts what it
//! uses, and takes with it whatever it leaves running.
//!
//! A scope is a unit of its own, so a session in one still lives through a restart of the
//! executor, whose unit it is not part of. The scopes are the manager's that the executor
//! runs under: the user's own, or the system's for root. Sessions are together in the
//! slice `aperture-sessions.slice`, which may be given limits for all of them at once.

use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use tokio::process::Command;
use tracing::warn;

use crate::limits::Limits;

const CGROUPS: &str = "/sys/fs/cgroup";
const SLICE: &str = "aperture-sessions.slice";

/// What a session uses.
#[derive(Debug, Clone, Copy, Default)]
pub struct Usage {
    pub memory: u64,
    pub memory_peak: u64,
    pub cpu: Duration,
    pub tasks: u64,
    /// Processes of the session the kernel killed because the session was out of memory.
    pub oom_kills: u64,
}

pub struct Scopes {
    systemd_run: PathBuf,
    systemctl: PathBuf,
    /// The scopes are the user's manager's.
    user: bool,
}

impl Scopes {
    /// Fails unless the manager makes scopes for the executor.
    pub async fn new(systemd_run: PathBuf, systemctl: PathBuf) -> io::Result<Self> {
        // Safety: no arguments, cannot fail.
        let user = unsafe { libc::getuid() } != 0;
        let scopes = Self {
            systemd_run,
            systemctl,
            user,
        };
        let tried = scopes
            .run()
            .args(["--scope", "--quiet", "--collect", "--slice", SLICE, "--"])
            .arg("true")
            .stdin(Stdio::null())
            .output()
            .await?;
        if !tried.status.success() {
            let said = String::from_utf8_lossy(&tried.stderr);
            return Err(io::Error::other(format!(
                "systemd made no scope: {}",
                said.trim()
            )));
        }
        Ok(scopes)
    }

    fn run(&self) -> Command {
        let mut command = Command::new(&self.systemd_run);
        if self.user {
            command.arg("--user");
        }
        command
    }

    fn unit(id: &str) -> String {
        format!("aperture-session-{id}.scope")
    }

    /// The command that starts `program` as the session's scope, with its limits. The
    /// program takes the place of what starts it, so the command's process is its own.
    pub fn start(&self, id: &str, limits: &Limits, program: &Path) -> Command {
        let or_none = |limit: Option<String>| limit.unwrap_or_else(|| "infinity".to_owned());
        let mut command = self.run();
        command
            .args(["--scope", "--quiet", "--collect", "--slice", SLICE])
            .arg("--unit")
            .arg(Self::unit(id))
            .arg("--property")
            .arg(format!(
                "MemoryMax={}",
                or_none(limits.memory.map(|bytes| bytes.to_string()))
            ))
            .arg("--property")
            .arg(format!(
                "TasksMax={}",
                or_none(limits.tasks.map(|tasks| tasks.to_string()))
            ))
            // A session that is out of memory loses a process, not everything.
            .args(["--property", "OOMPolicy=continue"]);
        if limits.memory.is_some() {
            // A session that could move what is over its limit to swap without end would
            // have no limit, and would slow the machine down instead: it gets as much
            // swap as it is given, and none unless it is given any.
            command
                .arg("--property")
                .arg(format!("MemorySwapMax={}", limits.swap.unwrap_or(0)));
        }
        if let Some(cpus) = limits.cpus {
            command
                .arg("--property")
                .arg(format!("CPUQuota={:.0}%", (cpus * 100.0).max(1.0)));
        }
        command.arg("--").arg(program);
        command
    }

    /// What the session uses, by a process of it.
    pub fn usage(&self, id: &str, pid: u32) -> Option<Usage> {
        let own = fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
        let own = own.lines().find_map(|line| line.strip_prefix("0::"))?;
        let group = Path::new(CGROUPS).join(own.trim_start_matches('/'));
        // The process may be gone, and its number someone else's.
        if group.file_name()? != Self::unit(id).as_str() {
            return None;
        }
        let number = |file: &str| -> Option<u64> {
            fs::read_to_string(group.join(file))
                .ok()?
                .trim()
                .parse()
                .ok()
        };
        // A line `<key> <number>` of a file of them.
        let keyed = |file: &str, key: &str| -> Option<u64> {
            let content = fs::read_to_string(group.join(file)).ok()?;
            content.lines().find_map(|line| {
                let (name, value) = line.split_once(' ')?;
                (name == key).then(|| value.trim().parse().ok())?
            })
        };
        Some(Usage {
            memory: number("memory.current")?,
            memory_peak: number("memory.peak").unwrap_or_default(),
            cpu: Duration::from_micros(keyed("cpu.stat", "usage_usec").unwrap_or_default()),
            tasks: number("pids.current").unwrap_or_default(),
            oom_kills: keyed("memory.events", "oom_kill").unwrap_or_default(),
        })
    }

    /// The sessions that have a scope, whatever runs in it.
    pub async fn sessions(&self) -> Vec<String> {
        let mut command = Command::new(&self.systemctl);
        if self.user {
            command.arg("--user");
        }
        let listed = command
            .args([
                "list-units",
                "--all",
                "--plain",
                "--no-legend",
                "--full",
                "--type=scope",
            ])
            .arg(Self::unit("*"))
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .await;
        let listed = match listed {
            Ok(listed) if listed.status.success() => listed.stdout,
            Ok(listed) => {
                warn!(status = %listed.status, "systemctl did not list the sessions' scopes");
                return Vec::new();
            }
            Err(err) => {
                warn!(%err, "failed to run systemctl to list the sessions' scopes");
                return Vec::new();
            }
        };
        String::from_utf8_lossy(&listed)
            .lines()
            // A unit that failed may be marked before its name.
            .filter_map(|line| {
                line.split_whitespace()
                    .find(|word| word.ends_with(".scope"))
            })
            .filter_map(|unit| {
                unit.strip_prefix("aperture-session-")?
                    .strip_suffix(".scope")
                    .map(str::to_owned)
            })
            .collect()
    }

    /// Ends whatever the session left running. Its scope goes with its last process.
    pub async fn close(&self, id: &str) {
        let mut command = Command::new(&self.systemctl);
        if self.user {
            command.arg("--user");
        }
        // There is no scope to stop when the session left nothing, which is as it should
        // be: only systemctl not running at all is worth a word.
        let stopped = command
            .args(["stop", "--quiet"])
            .arg(Self::unit(id))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        if let Err(err) = stopped {
            warn!(session = %id, %err, "failed to run systemctl to end what a session left");
        }
    }
}
