//! The node's sessions: what the store keeps of them, and the runner each one has while its
//! browser runs.
//!
//! Runners are processes of their own, apart from the executor: a session lives through an
//! executor restart, and the executor finds it again by its runtime directory. Nothing
//! about a running session is kept in memory here; its state is read from that directory.

use std::{
    collections::HashMap,
    fs,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use aperture_runner::{
    Cdp, Live, Phase, PortRange, Profile, Spec, Status, Tools, Viewport, is_alive, read_status,
};
use aperture_store::{SessionRecord, SnapshotRecord, Store, StoreError};
use tokio::time::{Instant, sleep};
use tracing::{info, warn};

/// The runner gives up on its own parts sooner than this.
const START_WITHIN: Duration = Duration::from_secs(120);
const STOP_WITHIN: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(50);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("session {0} is not running")]
    NotRunning(String),
    #[error("session {id} failed to start: {reason}")]
    Start { id: String, reason: String },
    #[error("session {0} did not stop")]
    Stop(String),
    #[error("{0}: {1}")]
    Io(PathBuf, std::io::Error),
}

type Result<T> = std::result::Result<T, Error>;

pub struct Config {
    /// Each session's runtime directory is below this one.
    pub runtime_root: PathBuf,
    pub runner: PathBuf,
    pub tools: Tools,
    pub viewport: Viewport,
    pub rtc_ports: Option<PortRange>,
    pub browser_args: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Suspended,
    Starting,
    Running,
    Suspending,
    Failed,
}

pub struct Session {
    pub record: SessionRecord,
    pub state: State,
    /// What the runner reports, while there is one or of the last one.
    pub status: Option<Status>,
}

pub struct Sessions {
    store: Store,
    config: Config,
    /// One operation at a time per session.
    busy: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Sessions {
    pub fn new(store: Store, config: Config) -> Self {
        Self {
            store,
            config,
            busy: Mutex::default(),
        }
    }

    pub async fn create(&self, snapshot_id: Option<&str>, suspended: bool) -> Result<Session> {
        let record = self.store.create_session(snapshot_id)?;
        info!(session = %record.id, ?snapshot_id, "session created");
        if !suspended {
            let _busy = self.busy(&record.id).await;
            self.start(&record.id).await?;
        }
        self.get(&record.id)
    }

    pub fn get(&self, id: &str) -> Result<Session> {
        self.observe(self.store.session(id)?)
    }

    pub fn list(&self) -> Result<Vec<Session>> {
        self.store
            .sessions()?
            .into_iter()
            .map(|record| self.observe(record))
            .collect()
    }

    pub async fn resume(&self, id: &str) -> Result<Session> {
        self.store.session(id)?;
        let _busy = self.busy(id).await;
        self.start(id).await?;
        self.get(id)
    }

    pub async fn suspend(&self, id: &str) -> Result<Session> {
        self.store.session(id)?;
        let _busy = self.busy(id).await;
        self.stop(id).await?;
        self.get(id)
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        self.store.session(id)?;
        let busy = self.busy(id).await;
        self.stop(id).await?;
        // A profile can be large.
        tokio::task::block_in_place(|| self.store.delete_session(id))?;
        remove_dir_all(&self.runtime_dir(id))?;
        drop(busy);
        self.busy.lock().expect("not poisoned").remove(id);
        info!(session = %id, "session deleted");
        Ok(())
    }

    /// Takes a snapshot of the session's profile. The profile must be at rest for it, so a
    /// running session is suspended and started again.
    pub async fn snapshot(&self, session_id: &str, name: Option<&str>) -> Result<SnapshotRecord> {
        self.store.session(session_id)?;
        let _busy = self.busy(session_id).await;
        let running = is_alive(&self.runtime_dir(session_id))
            .map_err(|err| Error::Io(self.runtime_dir(session_id), err))?;
        self.stop(session_id).await?;
        let snapshot = self.store.create_snapshot(session_id, name);
        if running {
            self.start(session_id).await?;
        }
        let snapshot = snapshot?;
        info!(session = %session_id, snapshot = %snapshot.id, "snapshot taken");
        Ok(snapshot)
    }

    pub fn snapshots(&self) -> Result<Vec<SnapshotRecord>> {
        Ok(self.store.snapshots()?)
    }

    pub fn get_snapshot(&self, id: &str) -> Result<SnapshotRecord> {
        Ok(self.store.snapshot(id)?)
    }

    pub fn delete_snapshot(&self, id: &str) -> Result<()> {
        Ok(self.store.delete_snapshot(id)?)
    }

    /// The DevTools endpoint of a running session.
    pub fn cdp(&self, id: &str) -> Result<Cdp> {
        let session = self.get(id)?;
        match (session.state, session.status.and_then(|status| status.cdp)) {
            (State::Running, Some(cdp)) => Ok(cdp),
            _ => Err(Error::NotRunning(id.to_owned())),
        }
    }

    /// The live endpoints of a running session.
    pub fn live(&self, id: &str) -> Result<Live> {
        let session = self.get(id)?;
        match (session.state, session.status.and_then(|status| status.live)) {
            (State::Running, Some(live)) => Ok(live),
            _ => Err(Error::NotRunning(id.to_owned())),
        }
    }

    fn observe(&self, record: SessionRecord) -> Result<Session> {
        let runtime = self.runtime_dir(&record.id);
        let io = |err| Error::Io(runtime.clone(), err);
        let alive = is_alive(&runtime).map_err(io)?;
        let mut status = read_status(&runtime).map_err(io)?;
        let phase = status.as_ref().map(|status| status.phase);
        let state = match (alive, phase) {
            (true, Some(Phase::Running)) => State::Running,
            (true, Some(Phase::Stopping)) => State::Suspending,
            (true, _) => State::Starting,
            (false, None | Some(Phase::Stopped)) => State::Suspended,
            (false, Some(Phase::Failed)) => State::Failed,
            // The runner was killed, or the machine restarted under it.
            (false, Some(_)) => {
                if let Some(status) = &mut status {
                    status.failure = Some("the session's runner ended without stopping it".into());
                }
                State::Failed
            }
        };
        Ok(Session {
            record,
            state,
            status,
        })
    }

    /// Starts the session's runner and waits until its browser serves. Does nothing for a
    /// session that has one.
    async fn start(&self, id: &str) -> Result<()> {
        let runtime = self.runtime_dir(id);
        let io = |err| Error::Io(runtime.clone(), err);
        if is_alive(&runtime).map_err(io)? {
            return self.await_running(id, None).await;
        }

        let paths = self.store.session_paths(id)?;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&runtime)
            .map_err(io)?;
        remove_file(&aperture_runner::status_path(&runtime))?;
        let spec = Spec {
            session_id: id.to_owned(),
            runtime_dir: runtime.clone(),
            profile: Profile {
                lowers: paths.lowers,
                upper: paths.upper,
                work: paths.work,
            },
            cache_dir: paths.cache,
            files_dir: paths.files,
            tools: self.config.tools.clone(),
            viewport: self.config.viewport,
            rtc_ports: self.config.rtc_ports,
            browser_args: self.config.browser_args.clone(),
        };
        fs::write(
            aperture_runner::spec_path(&runtime),
            serde_json::to_vec_pretty(&spec).expect("a spec is serializable"),
        )
        .map_err(io)?;

        let log_path = paths.logs.join("runner.log");
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|err| Error::Io(log_path.clone(), err))?;
        let child = tokio::process::Command::new(&self.config.runner)
            .arg(&runtime)
            // Whatever a process of the session leaves where it runs, a core dump for one,
            // goes with the session.
            .current_dir(&runtime)
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|err| Error::Io(log_path, err))?)
            .stderr(log)
            // A group of its own: signals to the executor's group, such as Ctrl+C in a
            // terminal, are not for the sessions.
            .process_group(0)
            .spawn()
            .map_err(|err| Error::Io(self.config.runner.clone(), err))?;
        info!(session = %id, "session starting");
        self.await_running(id, Some(child)).await
    }

    /// Waits for the runner to report the session running. `runner` is the runner when this
    /// executor started it, which tells when it exits before it took its lock.
    async fn await_running(&self, id: &str, runner: Option<tokio::process::Child>) -> Result<()> {
        let runtime = self.runtime_dir(id);
        let io = |err| Error::Io(runtime.clone(), err);
        let deadline = Instant::now() + START_WITHIN;
        let mut runner = runner;
        let outcome = loop {
            let status = read_status(&runtime).map_err(io)?;
            match status.as_ref().map(|status| status.phase) {
                Some(Phase::Running) => break Ok(()),
                Some(Phase::Failed | Phase::Stopped | Phase::Stopping) => {
                    break Err(status
                        .and_then(|status| status.failure)
                        .unwrap_or_else(|| "it was stopped while starting".into()));
                }
                Some(Phase::Starting) | None => {}
            }
            let exited = match &mut runner {
                Some(runner) => runner.try_wait().map_err(io)?.is_some(),
                None => !is_alive(&runtime).map_err(io)?,
            };
            if exited {
                // What it wrote last, before exiting.
                let failure = read_status(&runtime)
                    .map_err(io)?
                    .and_then(|status| status.failure);
                break Err(failure.unwrap_or_else(|| "the runner exited".into()));
            }
            if Instant::now() >= deadline {
                break Err("it did not start in time".into());
            }
            sleep(POLL).await;
        };
        if let Some(mut runner) = runner {
            // Reaped whenever it exits.
            tokio::spawn(async move { runner.wait().await });
        }
        outcome.map_err(|reason| Error::Start {
            id: id.to_owned(),
            reason,
        })
    }

    /// Stops the session's runner, and with it the browser, and waits for both to be gone.
    /// A session that failed is left suspended.
    async fn stop(&self, id: &str) -> Result<()> {
        let runtime = self.runtime_dir(id);
        let io = |err| Error::Io(runtime.clone(), err);
        let deadline = Instant::now() + STOP_WITHIN;
        let mut signalled = false;
        while is_alive(&runtime).map_err(io)? {
            // The lock is held, so the pid in the status is the runner's. A runner that
            // has not written one yet does so right away.
            if let Some(status) = read_status(&runtime).map_err(io)? {
                let pid = status.pid as libc::pid_t;
                if !signalled {
                    // Safety: plain signal to a process of this user.
                    unsafe { libc::kill(pid, libc::SIGTERM) };
                    signalled = true;
                } else if Instant::now() >= deadline {
                    warn!(session = %id, "the runner did not stop in time; killing its group");
                    // Safety: as above, to the group the runner was started as.
                    unsafe { libc::kill(-pid, libc::SIGKILL) };
                    sleep(Duration::from_millis(500)).await;
                    if is_alive(&runtime).map_err(io)? {
                        return Err(Error::Stop(id.to_owned()));
                    }
                    break;
                }
            }
            sleep(POLL).await;
        }
        remove_file(&aperture_runner::status_path(&runtime))?;
        if signalled {
            info!(session = %id, "session suspended");
        }
        Ok(())
    }

    async fn busy(&self, id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self
            .busy
            .lock()
            .expect("not poisoned")
            .entry(id.to_owned())
            .or_default()
            .clone();
        lock.lock_owned().await
    }

    fn runtime_dir(&self, id: &str) -> PathBuf {
        self.config.runtime_root.join(id)
    }
}

fn remove_file(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
            Err(Error::Io(path.to_owned(), err))
        }
        _ => Ok(()),
    }
}

fn remove_dir_all(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
            Err(Error::Io(path.to_owned(), err))
        }
        _ => Ok(()),
    }
}
