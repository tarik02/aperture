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
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use aperture_gateway::Refused;
use aperture_runner::{
    Cdp, Features, Live, Network, Phase, Profile, Status, is_alive,
    options::{Directories, Setup},
    proxy, read_status,
};
use aperture_store::{SessionRecord, SnapshotRecord, Store, StoreError};
use axum::http::StatusCode;
use futures_util::future::BoxFuture;
use tokio::time::{Instant, sleep};
use tracing::{info, warn};

use crate::{
    asked::Asked,
    limits::Limits,
    scopes::{Scopes, Usage},
};

/// The runner gives up on its own parts sooner than this.
const START_WITHIN: Duration = Duration::from_secs(120);
const STOP_WITHIN: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(50);
/// How often sessions are looked at for having sat idle too long.
const IDLE_CHECK: Duration = Duration::from_secs(10);

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
    #[error("invalid proxy configuration: {0}")]
    Proxy(String),
    #[error("invalid limits: {0}")]
    Limits(String),
    #[error("{0}")]
    Options(String),
    #[error(
        "this executor cannot hold a session to limits on what it uses: it runs without \
        --session-scopes"
    )]
    NoCgroups,
    #[error("{0}: {1}")]
    Io(PathBuf, std::io::Error),
}

type Result<T> = std::result::Result<T, Error>;

pub struct Config {
    /// Each session's runtime directory is below this one.
    pub runtime_root: PathBuf,
    pub runner: PathBuf,
    /// How sessions run.
    pub setup: Setup,
    /// The limits of a session that has none of its own.
    pub limits: Limits,
    /// What holds sessions to their limits; without it they are not.
    pub scopes: Option<Scopes>,
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
    /// The limits it is held to.
    pub limits: Limits,
    /// What it offers and the network its browser has, when it runs.
    pub features: Features,
    pub network: Network,
    pub usage: Option<Usage>,
    /// Since when nobody uses it, in milliseconds since the epoch, while it runs and
    /// nobody does.
    pub idle_since_ms: Option<u64>,
}

/// Who uses a session, as far as the executor sees: everything that reaches one goes
/// through it.
#[derive(Clone, Copy)]
struct Activity {
    /// Connections that are open.
    present: usize,
    /// When something last reached it, in milliseconds since the epoch.
    last_ms: u64,
}

/// A connection to a session, for as long as this is kept.
pub struct Presence {
    sessions: Arc<Sessions>,
    id: String,
}

impl Drop for Presence {
    fn drop(&mut self) {
        self.sessions.touch(&self.id, -1);
    }
}

pub struct Sessions {
    store: Store,
    config: Config,
    /// One operation at a time per session.
    busy: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Of the sessions something reached since this executor started.
    activity: Mutex<HashMap<String, Activity>>,
}

impl Sessions {
    pub fn new(store: Store, config: Config) -> Self {
        Self {
            store,
            config,
            busy: Mutex::default(),
            activity: Mutex::default(),
        }
    }

    /// Notes that something reached the session, and that `connections` more are open.
    fn touch(&self, id: &str, connections: isize) {
        let mut activity = self.activity.lock().expect("not poisoned");
        let activity = activity.entry(id.to_owned()).or_insert(Activity {
            present: 0,
            last_ms: 0,
        });
        activity.present = activity.present.saturating_add_signed(connections);
        activity.last_ms = now_ms();
    }

    /// A connection to the session that stays open: the session is in use until what this
    /// returns is dropped.
    pub fn present(self: &Arc<Self>, id: &str) -> Presence {
        self.touch(id, 1);
        Presence {
            sessions: self.clone(),
            id: id.to_owned(),
        }
    }

    /// Suspends the sessions that sat idle for longer than they may, for as long as the
    /// executor runs.
    pub async fn suspend_idle(self: Arc<Self>) {
        loop {
            sleep(IDLE_CHECK).await;
            let sessions = match self.list() {
                Ok(sessions) => sessions,
                Err(err) => {
                    warn!("failed to look for idle sessions: {err}");
                    continue;
                }
            };
            for session in sessions {
                let id = &session.record.id;
                let (Some(allowed), Some(since)) = (session.limits.idle(), session.idle_since_ms)
                else {
                    continue;
                };
                let idle = Duration::from_millis(now_ms().saturating_sub(since));
                if idle < allowed || self.is_busy(&session).await {
                    continue;
                }
                info!(session = %id, ?idle, "session sat idle; suspending it");
                if let Err(err) = self.sleep(id).await {
                    warn!(session = %id, "failed to suspend an idle session: {err}");
                }
            }
        }
    }

    /// Whether the session does something nobody has to be connected for. One that does
    /// not say is taken to.
    async fn is_busy(&self, session: &Session) -> bool {
        let Some(live) = session
            .status
            .as_ref()
            .and_then(|status| status.live.as_ref())
        else {
            return true;
        };
        match aperture_gateway::ask(&live.socket, "/busy").await {
            Ok(busy) => busy
                .as_object()
                .is_none_or(|busy| busy.values().any(|count| count.as_u64() != Some(0))),
            Err(_) => true,
        }
    }

    pub async fn create(
        &self,
        snapshot_id: Option<&str>,
        suspended: bool,
        proxy: Option<proxy::Config>,
        limits: Limits,
        options: Asked,
    ) -> Result<Session> {
        let proxy = proxy.map(checked).transpose()?;
        options.check(&self.config.setup).map_err(Error::Options)?;
        let options = (options != Asked::default())
            .then(|| serde_json::to_value(options).expect("options are serializable"));
        limits.check().map_err(Error::Limits)?;
        if limits.over(Limits::default()).on_resources() && self.config.scopes.is_none() {
            return Err(Error::NoCgroups);
        }
        let limits = (limits != Limits::default())
            .then(|| serde_json::to_value(limits).expect("limits are serializable"));
        let record = self
            .store
            .create_session(snapshot_id, proxy, limits, options)?;
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

    /// Sets how the session's connections are routed, for its running browser at once.
    pub async fn set_proxy(&self, id: &str, proxy: Option<proxy::Config>) -> Result<()> {
        self.store.session(id)?;
        let _busy = self.busy(id).await;
        let config = proxy.clone().unwrap_or_default();
        self.store
            .set_session_proxy(id, proxy.map(checked).transpose()?)?;
        match self.running_live(id) {
            Ok(live) => {
                let body = serde_json::to_vec(&config).expect("a configuration is serializable");
                aperture_gateway::put(&live.socket, "/proxy", body)
                    .await
                    .map_err(|reason| Error::Proxy(format!("{reason:#}")))?;
            }
            // It takes the configuration when it next starts.
            Err(Error::NotRunning(_)) => {}
            Err(err) => return Err(err),
        }
        info!(session = %id, rules = config.rules.len(), "session proxy set");
        Ok(())
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
        // Whoever asked for this resumes it too.
        self.store.set_session_asleep(id, false)?;
        self.get(id)
    }

    /// Suspends a session that sat idle, until someone reaches it.
    async fn sleep(&self, id: &str) -> Result<()> {
        self.store.session(id)?;
        let _busy = self.busy(id).await;
        // Before it stops: whoever reaches it while it does waits and resumes it.
        self.store.set_session_asleep(id, true)?;
        self.stop(id).await
    }

    /// Resumes the session if it was suspended for sitting idle.
    async fn wake(&self, id: &str) -> Result<()> {
        if !self.store.session(id)?.asleep {
            return Ok(());
        }
        let _busy = self.busy(id).await;
        // Someone else may have been here first.
        if self.store.session(id)?.asleep {
            info!(session = %id, "someone reached a session that sat idle; resuming it");
            self.start(id).await?;
        }
        Ok(())
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

    /// The DevTools endpoint of a running session, for someone who reaches it.
    pub async fn cdp(&self, id: &str) -> Result<Cdp> {
        self.wake(id).await?;
        self.touch(id, 0);
        let session = self.get(id)?;
        match (session.state, session.status.and_then(|status| status.cdp)) {
            (State::Running, Some(cdp)) => Ok(cdp),
            _ => Err(Error::NotRunning(id.to_owned())),
        }
    }

    /// The live endpoints of a running session, for someone who reaches it.
    pub async fn live(&self, id: &str) -> Result<Live> {
        self.wake(id).await?;
        self.touch(id, 0);
        self.running_live(id)
    }

    fn running_live(&self, id: &str) -> Result<Live> {
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
        let own = kept_limits(record.limits.clone())?;
        let (features, network) = kept_options(record.options.clone())?.within(&self.config.setup);
        let running = state == State::Running;
        let idle_since_ms = running
            .then(|| {
                let mut activity = self.activity.lock().expect("not poisoned");
                // Nothing is known of one that ran before this executor did: it is taken
                // to have been used last when the executor first saw it.
                *activity.entry(record.id.clone()).or_insert(Activity {
                    present: 0,
                    last_ms: now_ms(),
                })
            })
            .filter(|activity| activity.present == 0)
            .map(|activity| activity.last_ms);
        let usage = match (&self.config.scopes, &status) {
            (Some(scopes), Some(status)) if alive => scopes.usage(&record.id, status.pid),
            _ => None,
        };
        Ok(Session {
            limits: own.over(self.config.limits),
            features,
            network,
            usage,
            idle_since_ms,
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
            self.await_running(id, None).await?;
            self.store.set_session_asleep(id, false)?;
            return Ok(());
        }

        let paths = self.store.session_paths(id)?;
        // Checked when it was set. One that is not read keeps the session from starting:
        // its browser would go out another way than it was told to.
        let record = self.store.session(id)?;
        let proxy = match record.proxy {
            Some(proxy) => serde_json::from_value(proxy)
                .map_err(|err| Error::Proxy(format!("what is kept of it is not read: {err}")))?,
            None => proxy::Config::default(),
        };
        let limits = kept_limits(record.limits)?.over(self.config.limits);
        let (features, network) = kept_options(record.options)?.within(&self.config.setup);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&runtime)
            .map_err(io)?;
        remove_file(&aperture_runner::status_path(&runtime))?;
        let directories = Directories {
            profile: Profile {
                lowers: paths.lowers,
                upper: paths.upper,
                work: paths.work,
            },
            cache: paths.cache,
            files: paths.files,
            state: paths.state,
        };
        let spec =
            self.config
                .setup
                .spec(id, runtime.clone(), directories, proxy, features, network);
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
        let mut command = match &self.config.scopes {
            Some(scopes) => {
                // What the session's last run left behind would keep its scope's name.
                scopes.close(id).await;
                scopes.start(id, &limits, &self.config.runner)
            }
            None => tokio::process::Command::new(&self.config.runner),
        };
        let child = command
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
        // Whoever started it uses it.
        self.touch(id, 0);
        self.await_running(id, Some(child)).await?;
        self.store.set_session_asleep(id, false)?;
        Ok(())
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
        if let Some(scopes) = &self.config.scopes {
            scopes.close(id).await;
        }
        self.activity.lock().expect("not poisoned").remove(id);
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

/// Where a session is reached: its own routes are below this.
pub fn path(session_id: &str) -> String {
    format!("/sessions/{session_id}")
}

/// The node's sessions, as the gateway reaches them.
pub struct Door(pub Arc<Sessions>);

impl aperture_gateway::Sessions for Door {
    fn live<'a>(&'a self, id: &'a str) -> BoxFuture<'a, std::result::Result<Live, Refused>> {
        Box::pin(async move { self.0.live(id).await.map_err(refused) })
    }

    fn cdp<'a>(&'a self, id: &'a str) -> BoxFuture<'a, std::result::Result<Cdp, Refused>> {
        Box::pin(async move { self.0.cdp(id).await.map_err(refused) })
    }

    fn present(&self, id: &str) -> Box<dyn Send> {
        Box::new(self.0.present(id))
    }
}

fn refused(err: Error) -> Refused {
    let status = match &err {
        Error::NotRunning(_) => StatusCode::CONFLICT,
        Error::Store(StoreError::SessionNotFound(_) | StoreError::InvalidId(_)) => {
            StatusCode::NOT_FOUND
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    Refused {
        status,
        reason: err.to_string(),
    }
}

/// A proxy configuration as the store keeps it, once it is known to be one the runner
/// takes.
fn checked(proxy: proxy::Config) -> Result<serde_json::Value> {
    proxy.compile().map_err(Error::Proxy)?;
    Ok(serde_json::to_value(proxy).expect("a configuration is serializable"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// The limits a session's record keeps; none of its own when it keeps none.
fn kept_limits(kept: Option<serde_json::Value>) -> Result<Limits> {
    match kept {
        Some(limits) => serde_json::from_value(limits)
            .map_err(|err| Error::Limits(format!("what is kept of them is not read: {err}"))),
        None => Ok(Limits::default()),
    }
}

/// The options a session's record keeps; none of its own when it keeps none.
fn kept_options(kept: Option<serde_json::Value>) -> Result<Asked> {
    match kept {
        Some(options) => serde_json::from_value(options).map_err(|err| {
            Error::Options(format!("what is kept of its options is not read: {err}"))
        }),
        None => Ok(Asked::default()),
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
