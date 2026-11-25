//! The node's sessions: what the store keeps of them, and the runner each one has while its
//! browser runs.
//!
//! Runners are processes of their own, apart from the executor: a session lives through an
//! executor restart, and the executor finds it again by its runtime directory. Nothing
//! about a running session is kept in memory here; its state is read from that directory.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom},
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, MetadataExt},
    },
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
use aperture_store::{SessionRecord, SnapshotRecord, Store, StoreError, remote::Remote};
use axum::http::StatusCode;
use futures_util::future::BoxFuture;
use tokio::time::{Instant, sleep};
use tracing::{info, warn};

use crate::{
    asked::Asked,
    limits::Limits,
    metrics::{self, Event, Start},
    scopes::{Scopes, Usage},
};

/// The runner gives up on its own parts sooner than this.
const START_WITHIN: Duration = Duration::from_secs(120);
const STOP_WITHIN: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(50);
/// How long a runner that let go of its lock takes at most to exit.
const EXIT_WITHIN: Duration = Duration::from_secs(5);
/// How much of what a runner wrote the executor logs when its session fails to start.
const RUNNER_LINES_LOGGED: usize = 20;
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
    #[error("the storage state was not taken: {0}")]
    State(String),
    #[error("{0}")]
    Options(String),
    #[error(
        "this executor cannot hold a session to limits on what it uses: it runs without \
        --session-scopes"
    )]
    NoCgroups,
    #[error("session {id} is on node {node}; it is resumed here only as a takeover")]
    Held { id: String, node: String },
    #[error("this executor is not set up with a store nodes share sessions in")]
    SharesNone,
    #[error("session {0} runs here; only a session at rest is evicted")]
    Runs(String),
    #[error(
        "what this node has of session {0} is not what is where nodes share sessions; \
        it would be lost"
    )]
    OnlyHere(String),
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
    /// Where snapshots are kept for more nodes than this one; this node's own store
    /// without it.
    pub snapshots: Option<Remote>,
    /// Where sessions are put when they are suspended, for other nodes to resume them.
    pub shared_sessions: Option<Remote>,
    /// The name this node says it has sessions under, where nodes share them; it says
    /// nothing, and takes no other node's word, without one.
    pub holds_as: Option<String>,
    /// How many snapshots and sessions are on their way to or from those stores at a
    /// time.
    pub transfers: usize,
}

impl Config {
    /// Where the layers nodes share are: with the snapshots, which are made of them, or
    /// with the sessions where snapshots are not shared.
    fn shared_layers(&self) -> Option<&Remote> {
        self.snapshots.as_ref().or(self.shared_sessions.as_ref())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Suspended,
    Starting,
    /// Its browser runs and is being given the storage state the session was created
    /// with: it is not yet the session that was asked for.
    Restoring,
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
    /// What is on its way to or from the stores nodes share, no more at a time than the
    /// executor is set up for.
    transfers: tokio::sync::Semaphore,
    /// Held by whoever brings a snapshot to this node or puts one of its own where nodes
    /// share them, and wholly by whoever drops the snapshots that are gone from there:
    /// one on its way is not there yet.
    arriving: tokio::sync::RwLock<()>,
    /// The sessions whose browsers are being given what they were created with. Kept
    /// here alone: an executor that is restarted meanwhile tells such a session as
    /// running, with what of its state was in by then.
    restoring: Mutex<HashSet<String>>,
}

impl Sessions {
    pub fn new(store: Store, config: Config) -> Self {
        Self {
            transfers: tokio::sync::Semaphore::new(config.transfers),
            store,
            config,
            busy: Mutex::default(),
            activity: Mutex::default(),
            arriving: tokio::sync::RwLock::default(),
            restoring: Mutex::default(),
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
        self: &Arc<Self>,
        snapshot_id: Option<&str>,
        suspended: bool,
        proxy: Option<proxy::Config>,
        limits: Limits,
        options: Asked,
        storage_state: Option<&str>,
    ) -> Result<Session> {
        if let Some(state) = storage_state {
            if suspended {
                return Err(Error::State(
                    "a session that is created suspended has no browser to take it".into(),
                ));
            }
            serde_json::from_str::<serde_json::Value>(state)
                .map_err(|err| Error::State(format!("it is not JSON: {err}")))?;
        }
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
        if let (Some(remote), Some(id)) = (&self.config.snapshots, snapshot_id) {
            let _transfer = self.transfer().await;
            let _arriving = self.arriving.read().await;
            let snapshot = remote.snapshot(id).await?;
            remote.pull(&self.store, &snapshot).await?;
        }
        let record = self
            .store
            .create_session(snapshot_id, proxy, limits, options)?;
        if let (Some(shared), Some(layers)) =
            (&self.config.shared_sessions, self.config.shared_layers())
        {
            let _transfer = self.transfer().await;
            layers
                .push_layers(&self.store, record.base_layer.as_deref())
                .await?;
            shared.put_session(&record).await?;
        }
        info!(session = %record.id, ?snapshot_id, "session created");
        metrics::event(Event::Created);
        if !suspended {
            let _busy = self.busy(&record.id).await;
            self.hold(&record.id, false).await?;
            match storage_state {
                None => self.start(&record.id, Start::Create).await?,
                Some(state) => {
                    // Said before its browser is there: it is at no moment a session that
                    // runs without what it was to start with.
                    self.restoring(&record.id, true);
                    if let Err(err) = self.start_as(&record.id, true, Start::Create).await {
                        self.restoring(&record.id, false);
                        return Err(err);
                    }
                    tokio::spawn(self.clone().restore(record.id.clone(), state.to_owned()));
                }
            }
        }
        self.get(&record.id)
    }

    /// How this executor is set up.
    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn get(&self, id: &str) -> Result<Session> {
        self.observe(self.store.session(id)?)
    }

    /// The picture of what the session showed when it was last suspended; none for one
    /// that never was. Asking for it reaches nobody: a session at rest stays at rest.
    pub fn preview(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let picture = self
            .store
            .session_paths(id)?
            .state
            .join(aperture_runner::PREVIEW);
        match fs::read(&picture) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(Error::Io(picture, err)),
        }
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
        if let Some(shared) = &self.config.shared_sessions {
            shared.put_session(&self.store.session(id)?).await?;
        }
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

    pub async fn resume(&self, id: &str, takeover: bool) -> Result<Session> {
        let _busy = self.busy(id).await;
        self.hold(id, takeover).await?;
        self.bring(id).await?;
        self.store.session(id)?;
        self.start(id, Start::Resume).await?;
        self.get(id)
    }

    pub async fn suspend(&self, id: &str) -> Result<Session> {
        self.store.session(id)?;
        let _busy = self.busy(id).await;
        if self.stop(id).await? {
            metrics::event(Event::Suspended);
        }
        // Whoever asked for this resumes it too.
        self.store.set_session_asleep(id, false)?;
        self.share(id).await?;
        self.get(id)
    }

    /// Says where nodes share sessions that this node has the session, when it is set up
    /// to. Refused while another node says it has it, unless this is a takeover.
    async fn hold(&self, id: &str, takeover: bool) -> Result<()> {
        let (Some(shared), Some(node)) = (&self.config.shared_sessions, &self.config.holds_as)
        else {
            return Ok(());
        };
        match shared.hold(id, node, takeover).await? {
            None => Ok(()),
            Some(node) => Err(Error::Held {
                id: id.to_owned(),
                node,
            }),
        }
    }

    /// Up to as many at a time as the executor is set up for.
    async fn transfer(&self) -> tokio::sync::SemaphorePermit<'_> {
        self.transfers
            .acquire()
            .await
            .expect("the semaphore is never closed")
    }

    /// Brings the session from where nodes share sessions, when this node has none of it
    /// or another state than was last put there. A session that runs here is left alone.
    async fn bring(&self, id: &str) -> Result<()> {
        let (Some(shared), Some(layers)) =
            (&self.config.shared_sessions, self.config.shared_layers())
        else {
            return Ok(());
        };
        let runtime = self.runtime_dir(id);
        if is_alive(&runtime).map_err(|err| Error::Io(runtime, err))? {
            return Ok(());
        }
        let _transfer = self.transfer().await;
        // One that was never put there is this node's alone, if it is anyone's.
        let Some(theirs) = shared.session(id).await? else {
            return Ok(());
        };
        if self.store.has_session(id) && self.store.session(id)?.revision == theirs.revision {
            return Ok(());
        }
        let _arriving = layers
            .pull_layers(&self.store, theirs.base_layer.as_deref())
            .await?;
        let state = match theirs.revision {
            Some(_) => Some(shared.pull_state(&self.store, id).await?),
            // It was never suspended: it is as it was created.
            None => None,
        };
        // A profile can be large.
        tokio::task::block_in_place(|| self.store.adopt_session(&theirs, state.as_deref()))?;
        info!(session = %id, "session brought from where nodes share them");
        Ok(())
    }

    /// Puts the session, which is at rest, where nodes share sessions.
    async fn share(&self, id: &str) -> Result<()> {
        let (Some(shared), Some(layers)) =
            (&self.config.shared_sessions, self.config.shared_layers())
        else {
            return Ok(());
        };
        let _transfer = self.transfer().await;
        let base = self.store.session(id)?.base_layer;
        layers.push_layers(&self.store, base.as_deref()).await?;
        let revision = shared.push_state(&self.store, id).await?;
        self.store.set_session_revision(id, &revision)?;
        shared.put_session(&self.store.session(id)?).await?;
        // Once it is all there: another node may have it from now on.
        match &self.config.holds_as {
            Some(node) => Ok(shared.release(id, node).await?),
            None => Ok(()),
        }
    }

    /// Suspends a session that sat idle, until someone reaches it.
    async fn sleep(&self, id: &str) -> Result<()> {
        self.store.session(id)?;
        let _busy = self.busy(id).await;
        // Before it stops: whoever reaches it while it does waits and resumes it.
        self.store.set_session_asleep(id, true)?;
        if self.stop(id).await? {
            metrics::event(Event::IdleSuspended);
        }
        self.share(id).await
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
            self.hold(id, false).await?;
            self.bring(id).await?;
            self.start(id, Start::Wake).await?;
        }
        Ok(())
    }

    /// Drops this node's copy of a session that is at rest where nodes share sessions.
    pub async fn evict(&self, id: &str) -> Result<()> {
        let ours = self.store.session(id)?;
        let shared = self
            .config
            .shared_sessions
            .as_ref()
            .ok_or(Error::SharesNone)?;
        let busy = self.busy(id).await;
        let runtime = self.runtime_dir(id);
        if is_alive(&runtime).map_err(|err| Error::Io(runtime.clone(), err))? {
            return Err(Error::Runs(id.to_owned()));
        }
        // The same state as was last put there, or the node's is the only one there is.
        let theirs = shared.session(id).await?;
        if theirs.is_none_or(|theirs| theirs.revision != ours.revision) {
            return Err(Error::OnlyHere(id.to_owned()));
        }
        // A profile can be large.
        tokio::task::block_in_place(|| self.store.delete_session(id))?;
        remove_dir_all(&runtime)?;
        drop(busy);
        self.busy.lock().expect("not poisoned").remove(id);
        self.activity.lock().expect("not poisoned").remove(id);
        info!(session = %id, "session evicted; it stays where nodes share sessions");
        Ok(())
    }

    /// The sessions where nodes share them, each with the node that says it has it.
    pub async fn stored(&self) -> Result<Vec<(SessionRecord, Option<String>)>> {
        let shared = self
            .config
            .shared_sessions
            .as_ref()
            .ok_or(Error::SharesNone)?;
        Ok(shared.sessions().await?)
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        let here = self.store.has_session(id);
        let shared = match &self.config.shared_sessions {
            Some(shared) => shared.session(id).await?.map(|_| shared),
            None => None,
        };
        if !here && shared.is_none() {
            // Says so.
            self.store.session(id)?;
        }
        let busy = self.busy(id).await;
        if here {
            self.stop(id).await?;
            // A profile can be large.
            tokio::task::block_in_place(|| self.store.delete_session(id))?;
            remove_dir_all(&self.runtime_dir(id))?;
        }
        if let Some(shared) = shared {
            shared.delete_session(id).await?;
            // The session is gone either way; what it leaves is collected the next time
            // too.
            let layers = self.config.shared_layers().unwrap_or(shared);
            if let Err(err) = layers.collect(Some(shared)).await {
                warn!("failed to collect the layers nothing is built on: {err}");
            }
        }
        drop(busy);
        self.busy.lock().expect("not poisoned").remove(id);
        info!(session = %id, "session deleted");
        metrics::event(Event::Deleted);
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
            self.start(session_id, Start::Snapshot).await?;
        }
        let snapshot = snapshot?;
        if let Some(remote) = &self.config.snapshots {
            let _transfer = self.transfer().await;
            let _arriving = self.arriving.read().await;
            if let Err(err) = remote.push(&self.store, &snapshot).await {
                // A snapshot the other nodes do not have is none.
                self.store.delete_snapshot(&snapshot.id)?;
                return Err(err.into());
            }
        }
        info!(session = %session_id, snapshot = %snapshot.id, "snapshot taken");
        Ok(snapshot)
    }

    pub async fn snapshots(&self) -> Result<Vec<SnapshotRecord>> {
        let Some(remote) = &self.config.snapshots else {
            return Ok(self.store.snapshots()?);
        };
        // Not while a snapshot is on its way: the next time, then.
        let settled = self.arriving.try_write();
        let shared = remote.snapshots().await?;
        if settled.is_ok() {
            // What this node still has of snapshots that were deleted elsewhere.
            for gone in self.store.snapshots()? {
                if !shared.iter().any(|snapshot| snapshot.id == gone.id) {
                    self.store.delete_snapshot(&gone.id)?;
                }
            }
        }
        Ok(shared)
    }

    pub async fn get_snapshot(&self, id: &str) -> Result<SnapshotRecord> {
        match &self.config.snapshots {
            Some(remote) => Ok(remote.snapshot(id).await?),
            None => Ok(self.store.snapshot(id)?),
        }
    }

    pub async fn delete_snapshot(&self, id: &str) -> Result<()> {
        let Some(remote) = &self.config.snapshots else {
            return Ok(self.store.delete_snapshot(id)?);
        };
        remote.delete(id).await?;
        match self.store.delete_snapshot(id) {
            // It was never brought here.
            Err(StoreError::SnapshotNotFound(_)) => {}
            deleted => deleted?,
        }
        // The snapshot is gone either way; what it leaves is collected the next time too.
        if let Err(err) = remote.collect(self.config.shared_sessions.as_ref()).await {
            warn!("failed to collect the layers no snapshot is built on: {err}");
        }
        Ok(())
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
            // One that is being restored is watched meanwhile, and reached by what
            // restores it.
            (State::Running | State::Restoring, Some(live)) => Ok(live),
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
            (true, Some(Phase::Running)) if self.is_restoring(&record.id) => State::Restoring,
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

    fn restoring(&self, id: &str, underway: bool) {
        let mut restoring = self.restoring.lock().expect("not poisoned");
        if underway {
            restoring.insert(id.to_owned());
        } else {
            restoring.remove(id);
        }
    }

    fn is_restoring(&self, id: &str) -> bool {
        self.restoring.lock().expect("not poisoned").contains(id)
    }

    /// Puts the storage state a session was created with into its browser, which runs by
    /// now, and has the session say that it runs once all of it is in. A session that
    /// does not take it is stopped, and says that it failed and why: it is not the
    /// session that was asked for, and is not left looking like it.
    async fn restore(self: Arc<Self>, id: String, state: String) {
        let taken = match self.running_live(&id) {
            Ok(live) => aperture_gateway::put(&live.socket, "/storage-state", state.into_bytes())
                .await
                .map_err(|reason| format!("{reason:#}")),
            Err(err) => Err(err.to_string()),
        };
        // After whatever is done with the session meanwhile, which may be what kept the
        // state from being taken.
        let _busy = self.busy(&id).await;
        match taken {
            Ok(()) => info!(session = %id, "session restored"),
            Err(reason) => {
                warn!(session = %id, "the storage state was not taken: {reason}");
                if let Err(err) = self.failed_to_restore(&id, reason).await {
                    warn!(session = %id, "a session that was not restored is not told as failed: {err}");
                }
            }
        }
        self.restoring(&id, false);
    }

    async fn failed_to_restore(&self, id: &str, reason: String) -> Result<()> {
        // Deleted meanwhile: there is nothing left to tell of.
        if self.store.session(id).is_err() {
            return Ok(());
        }
        self.stop(id).await?;
        let runtime = self.runtime_dir(id);
        let status = Status {
            phase: Phase::Failed,
            pid: std::process::id(),
            cdp: None,
            live: None,
            failure: Some(Error::State(reason).to_string()),
        };
        aperture_runner::write_status(&runtime, &status).map_err(|err| Error::Io(runtime, err))
    }

    /// Starts the session's runner and waits until its browser serves. Does nothing for a
    /// session that has one.
    async fn start(&self, id: &str, kind: Start) -> Result<()> {
        self.start_as(id, false, kind).await
    }

    /// Starts it as one that is given a storage state next, where `restoring`: it says
    /// from its first moment that it is being restored.
    async fn start_as(&self, id: &str, restoring: bool, kind: Start) -> Result<()> {
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
        let mut spec =
            self.config
                .setup
                .spec(id, runtime.clone(), directories, proxy, features, network);
        spec.restoring = restoring;
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
        // What the session's last run left behind would hold its profile, and keep its
        // scope's name.
        self.end_leftovers(id).await;
        let starting = Instant::now();
        let mut command = match &self.config.scopes {
            Some(scopes) => scopes.start(id, &limits, &self.config.runner),
            None => tokio::process::Command::new(&self.config.runner),
        };
        let child = command
            .arg(&runtime)
            // Whatever a process of the session leaves where it runs, a core dump for one,
            // goes with the session.
            .current_dir(&runtime)
            .stdin(Stdio::null())
            .stdout(
                log.try_clone()
                    .map_err(|err| Error::Io(log_path.clone(), err))?,
            )
            .stderr(log)
            // A group of its own: signals to the executor's group, such as Ctrl+C in a
            // terminal, are not for the sessions.
            .process_group(0)
            .spawn()
            .map_err(|err| Error::Io(self.config.runner.clone(), err))?;
        info!(session = %id, "session starting");
        // Whoever started it uses it.
        self.touch(id, 0);
        match self.await_running(id, Some(child)).await {
            Ok(()) => metrics::started(kind, starting.elapsed()),
            Err(Error::Start { id, mut reason }) => {
                metrics::event(Event::Failed);
                // The reason is what the runner saw; why its browser exited is in what the
                // browser and its sandbox wrote, which is in the session's log alone.
                let output = last_lines(&log_path, RUNNER_LINES_LOGGED);
                if output.contains("Can't mount proc on /proc") {
                    reason.push_str(
                        "; the sandbox could not mount /proc, which the container masks: \
                         give the node's container systempaths=unconfined under Docker or \
                         unmask=ALL under podman",
                    );
                }
                warn!(session = %id, "session failed to start: {reason}; its runner wrote last:\n{output}");
                return Err(Error::Start { id, reason });
            }
            Err(err) => return Err(err),
        }
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
    /// A session that failed is left suspended. Says whether there was a runner to stop.
    async fn stop(&self, id: &str) -> Result<bool> {
        let runtime = self.runtime_dir(id);
        let io = |err| Error::Io(runtime.clone(), err);
        let deadline = Instant::now() + STOP_WITHIN;
        let mut signalled = None;
        while is_alive(&runtime).map_err(io)? {
            // The lock is held, so the pid in the status is the runner's. A runner that
            // has not written one yet does so right away.
            if let Some(status) = read_status(&runtime).map_err(io)? {
                let pid = status.pid as libc::pid_t;
                if signalled.is_none() {
                    // Safety: plain signal to a process of this user.
                    unsafe { libc::kill(pid, libc::SIGTERM) };
                    signalled = Some(pid);
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
        if let Some(pid) = signalled {
            // It lets go of its lock a moment before it exits, and is no leftover meanwhile.
            let deadline = Instant::now() + EXIT_WITHIN;
            while runner_of(pid, &self.config.runtime_root).as_deref() == Some(id)
                && Instant::now() < deadline
            {
                sleep(POLL).await;
            }
        }
        self.end_leftovers(id).await;
        self.activity.lock().expect("not poisoned").remove(id);
        if signalled.is_some() {
            info!(session = %id, "session suspended");
        }
        Ok(signalled)
    }

    /// Stops the runners that an earlier executor left without the state they are found by,
    /// as when the runtime directory was removed under them: no request would reach them or
    /// stop them, and each would hold its session's profile for as long as it runs. Their
    /// sessions are told as suspended after, which whoever wants them running resumes.
    /// Runners whose state is there are left alone: they are the sessions this executor
    /// goes on with.
    pub async fn sweep(&self) {
        let mut ids: HashSet<String> = runners(&self.config.runtime_root)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        if let Some(scopes) = &self.config.scopes {
            ids.extend(scopes.sessions().await);
        }
        let swept = ids.into_iter().map(|id| async move {
            let _busy = self.busy(&id).await;
            let runtime = self.runtime_dir(&id);
            match is_alive(&runtime) {
                Ok(true) => return,
                Ok(false) => {}
                Err(err) => warn!(session = %id, "the session's state is not read: {err}"),
            }
            warn!(
                session = %id,
                "the session's runner was left without its state; stopping it"
            );
            self.end_leftovers(&id).await;
            if let Err(err) = remove_file(&aperture_runner::status_path(&runtime)) {
                warn!(session = %id, "{err}");
            }
        });
        futures_util::future::join_all(swept).await;
    }

    /// Ends what is left of the session while no runner holds its runtime directory: its
    /// scope, or, without scopes, a runner an earlier executor started that holds a
    /// directory that is gone.
    async fn end_leftovers(&self, id: &str) {
        if let Some(scopes) = &self.config.scopes {
            scopes.close(id).await;
            return;
        }
        let root = &self.config.runtime_root;
        let left = runners(root)
            .into_iter()
            .filter(|(of, _)| of == id)
            .map(|(_, pid)| pid);
        for pid in left {
            warn!(session = %id, pid, "stopping a runner of the session that has no state");
            // Safety: plain signal to a process of this user, which was just seen to be
            // the session's runner.
            unsafe { libc::kill(pid, libc::SIGTERM) };
            let deadline = Instant::now() + STOP_WITHIN;
            while runner_of(pid, root).as_deref() == Some(id) {
                if Instant::now() >= deadline {
                    warn!(session = %id, pid, "the runner did not stop in time; killing its group");
                    // Safety: as above, to the group it was started as.
                    unsafe { libc::kill(-pid, libc::SIGKILL) };
                    break;
                }
                sleep(POLL).await;
            }
        }
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

/// The last `count` lines of the file, as far as its last 64 KiB hold them; none where it
/// cannot be read.
fn last_lines(path: &Path, count: usize) -> String {
    let mut bytes = Vec::new();
    let read = fs::File::open(path).and_then(|mut file| {
        let length = file.metadata()?.len();
        file.seek(SeekFrom::Start(length.saturating_sub(64 * 1024)))?;
        file.read_to_end(&mut bytes)
    });
    if read.is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

/// The runners of this user that run a session below `root`, by session: whichever
/// executor started them, and whether or not their runtime directory is still there.
fn runners(root: &Path) -> Vec<(String, libc::pid_t)> {
    let Ok(processes) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    processes
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
        .filter_map(|pid| Some((runner_of(pid, root)?, pid)))
        .collect()
}

/// The session the process runs as its runner, when it is this user's runner of a session
/// below `root`. A runner is started with its runtime directory as its one argument.
fn runner_of(pid: libc::pid_t, root: &Path) -> Option<String> {
    let process = PathBuf::from(format!("/proc/{pid}"));
    // Safety: no arguments, cannot fail.
    if fs::metadata(&process).ok()?.uid() != unsafe { libc::getuid() } {
        return None;
    }
    // Empty for a process that ended and is not reaped yet.
    let line = fs::read(process.join("cmdline")).ok()?;
    let arguments: Vec<&[u8]> = line.strip_suffix(b"\0")?.split(|&byte| byte == 0).collect();
    let [program, runtime] = arguments[..] else {
        return None;
    };
    let program = Path::new(std::ffi::OsStr::from_bytes(program));
    if program.file_name()? != "aperture-runner" {
        return None;
    }
    let runtime = Path::new(std::ffi::OsStr::from_bytes(runtime));
    if runtime.parent()? != root {
        return None;
    }
    Some(runtime.file_name()?.to_str()?.to_owned())
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
