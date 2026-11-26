//! What the node tells Prometheus of itself and its sessions, at `/metrics` on an address
//! of its own: it answers anyone who reaches it, and is kept apart from what sessions are
//! reached at.
//!
//! What happens is counted as it happens, whether or not anything is served: the counts
//! are a few numbers, and whatever records them need not know. What there is, the sessions
//! and what they use, is read when it is asked for.

use std::{
    ffi::CString,
    fmt,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, atomic::AtomicU64},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use aperture_gateway::Listen;
use axum::{
    Router,
    http::{StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use prometheus_client::{
    collector::Collector,
    encoding::{DescriptorEncoder, EncodeMetric, prometheus_text},
    metrics::{
        MetricType,
        counter::{ConstCounter, Counter},
        family::Family,
        gauge::{ConstGauge, Gauge},
        histogram::Histogram,
        info::Info,
    },
    registry::Registry,
};
use tracing::{info, warn};

use crate::{
    scopes::Usage,
    sessions::{Sessions, State},
};

/// As v1 had them: a browser takes from under a second to many to answer.
const START_BUCKETS: [f64; 12] = [
    0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 7.5, 10.0, 15.0, 20.0, 30.0, 60.0,
];

type Label = [(&'static str, &'static str); 1];

/// What happened to the sessions, as it is told of here.
pub enum Event {
    Created,
    Started,
    /// A browser that did not start.
    Failed,
    /// Suspended as it was asked to be.
    Suspended,
    /// Suspended for sitting idle.
    IdleSuspended,
    Deleted,
}

impl Event {
    fn label(&self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Started => "started",
            Self::Failed => "failed",
            Self::Suspended => "suspended",
            Self::IdleSuspended => "idle_suspended",
            Self::Deleted => "deleted",
        }
    }
}

/// Why a session's browser was started.
#[derive(Clone, Copy)]
pub enum Start {
    Create,
    Resume,
    /// Someone reached it after it was suspended for sitting idle.
    Wake,
    /// It runs again once its profile was taken as a snapshot.
    Snapshot,
}

impl Start {
    fn label(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Resume => "resume",
            Self::Wake => "wake",
            Self::Snapshot => "snapshot",
        }
    }
}

struct Recorded {
    events: Family<Label, Counter>,
    start_seconds: Family<Label, Histogram, fn() -> Histogram>,
    keepalives: Family<Label, Counter>,
    registered: Gauge,
    last_keepalive: Gauge<f64, AtomicU64>,
    scrape_errors: Family<Label, Counter>,
}

static RECORDED: LazyLock<Recorded> = LazyLock::new(|| Recorded {
    events: Family::default(),
    start_seconds: Family::new_with_constructor(|| Histogram::new(START_BUCKETS)),
    keepalives: Family::default(),
    registered: Gauge::default(),
    last_keepalive: Gauge::default(),
    scrape_errors: Family::default(),
});

pub fn event(event: Event) {
    RECORDED
        .events
        .get_or_create(&[("event", event.label())])
        .inc();
}

/// A browser that started, and how long it took to answer.
pub fn started(kind: Start, took: Duration) {
    event(Event::Started);
    RECORDED
        .start_seconds
        .get_or_create(&[("kind", kind.label())])
        .observe(took.as_secs_f64());
}

/// A keepalive the control plane took, or did not.
pub fn keepalive(taken: bool) {
    let result = if taken { "ok" } else { "failed" };
    RECORDED
        .keepalives
        .get_or_create(&[("result", result)])
        .inc();
    RECORDED.registered.set(taken.into());
    if taken {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        RECORDED.last_keepalive.set(now.as_secs_f64());
    }
}

/// What is read of the node each time it is asked.
struct Observed {
    sessions: Arc<Sessions>,
    per_session: bool,
    data_dir: PathBuf,
}

impl fmt::Debug for Observed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Observed").finish_non_exhaustive()
    }
}

const STATES: [(State, &str); 6] = [
    (State::Suspended, "suspended"),
    (State::Starting, "starting"),
    (State::Restoring, "restoring"),
    (State::Running, "running"),
    (State::Suspending, "suspending"),
    (State::Failed, "failed"),
];

impl Collector for Observed {
    fn encode(&self, mut encoder: DescriptorEncoder) -> fmt::Result {
        match self.sessions.list() {
            Ok(sessions) => {
                let mut family = encoder.encode_descriptor(
                    "sessions",
                    "Sessions on this node, by state",
                    None,
                    MetricType::Gauge,
                )?;
                for (state, name) in STATES {
                    let count = sessions.iter().filter(|one| one.state == state).count();
                    ConstGauge::new(count as i64)
                        .encode(family.encode_family(&[("status", name)])?)?;
                }
                if self.per_session {
                    let used: Vec<_> = sessions
                        .iter()
                        .filter_map(|one| Some((one.record.id.as_str(), one.usage?)))
                        .collect();
                    let mut gauge = |name: &str, help: &str, value: &dyn Fn(&Usage) -> u64| {
                        let mut family =
                            encoder.encode_descriptor(name, help, None, MetricType::Gauge)?;
                        for (id, usage) in &used {
                            ConstGauge::new(value(usage))
                                .encode(family.encode_family(&[("session_id", *id)])?)?;
                        }
                        fmt::Result::Ok(())
                    };
                    gauge(
                        "session_memory_bytes",
                        "Memory a running session uses, page cache it caused among it",
                        &|usage| usage.memory,
                    )?;
                    gauge(
                        "session_memory_peak_bytes",
                        "The most memory a running session used",
                        &|usage| usage.memory_peak,
                    )?;
                    gauge(
                        "session_tasks",
                        "Processes and threads of a running session",
                        &|usage| usage.tasks,
                    )?;
                    let mut family = encoder.encode_descriptor(
                        "session_cpu_seconds",
                        "Processor time a running session used",
                        None,
                        MetricType::Counter,
                    )?;
                    for (id, usage) in &used {
                        ConstCounter::new(usage.cpu.as_secs_f64())
                            .encode(family.encode_family(&[("session_id", *id)])?)?;
                    }
                    let mut family = encoder.encode_descriptor(
                        "session_oom_kills",
                        "Processes of a running session the kernel killed for its memory",
                        None,
                        MetricType::Counter,
                    )?;
                    for (id, usage) in &used {
                        ConstCounter::new(usage.oom_kills)
                            .encode(family.encode_family(&[("session_id", *id)])?)?;
                    }
                }
            }
            Err(err) => {
                warn!("the sessions are not counted for metrics: {err}");
                RECORDED
                    .scrape_errors
                    .get_or_create(&[("source", "sessions")])
                    .inc();
            }
        }
        match space(&self.data_dir) {
            Some((size, available)) => {
                let label = [("root", "data")];
                let mut family = encoder.encode_descriptor(
                    "storage_size_bytes",
                    "Size of the filesystem a root is on",
                    None,
                    MetricType::Gauge,
                )?;
                ConstGauge::new(size).encode(family.encode_family(&label)?)?;
                let mut family = encoder.encode_descriptor(
                    "storage_available_bytes",
                    "Space left to this program on the filesystem a root is on",
                    None,
                    MetricType::Gauge,
                )?;
                ConstGauge::new(available).encode(family.encode_family(&label)?)?;
            }
            None => {
                RECORDED
                    .scrape_errors
                    .get_or_create(&[("source", "storage")])
                    .inc();
            }
        }
        Ok(())
    }
}

/// The size of the filesystem the directory is on, and what of it is left to this program.
fn space(dir: &Path) -> Option<(u64, u64)> {
    let path = CString::new(dir.as_os_str().as_bytes()).ok()?;
    // Safety: a path that ends with a nul, and a struct the call fills in.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    Some((stat.f_blocks * stat.f_frsize, stat.f_bavail * stat.f_frsize))
}

pub struct Serving {
    pub listen: Listen,
    pub sessions: Arc<Sessions>,
    pub per_session: bool,
    pub data_dir: PathBuf,
    /// Whether the node registers with a control plane, which its keepalives are told of.
    pub registers: bool,
}

/// Listens where it is told to; what this returns serves the metrics there, for as long
/// as the executor runs.
pub async fn listen(
    serving: Serving,
) -> anyhow::Result<impl Future<Output = std::io::Result<()>> + use<>> {
    let mut registry = Registry::with_prefix("aperture");
    let commit = std::env::var("APERTURE_COMMIT").unwrap_or_default();
    registry.register(
        "build",
        "The build of the executor that serves the metrics; always 1",
        Info::new(vec![
            ("version", env!("CARGO_PKG_VERSION").to_owned()),
            ("commit", commit.trim().to_owned()),
        ]),
    );
    registry.register(
        "session_events",
        "What happened to sessions on this node",
        RECORDED.events.clone(),
    );
    registry.register(
        "session_start_duration_seconds",
        "Time until a started browser answers, by why it was started",
        RECORDED.start_seconds.clone(),
    );
    registry.register(
        "state_scrape_errors",
        "What was not read for a scrape, by what it is",
        RECORDED.scrape_errors.clone(),
    );
    if serving.registers {
        registry.register(
            "node_up",
            "1 while the control plane takes this node's keepalives, 0 while it does not",
            RECORDED.registered.clone(),
        );
        registry.register(
            "node_keepalives",
            "Keepalives this node said to its control plane, by whether they were taken",
            RECORDED.keepalives.clone(),
        );
        registry.register(
            "node_last_keepalive_timestamp_seconds",
            "When the control plane last took this node's keepalive, in seconds since the epoch",
            RECORDED.last_keepalive.clone(),
        );
    }
    registry.register_collector(Box::new(Observed {
        sessions: serving.sessions,
        per_session: serving.per_session,
        data_dir: serving.data_dir,
    }));
    let registry = Arc::new(registry);
    let routes = Router::new().route(
        "/metrics",
        get(move || {
            let registry = registry.clone();
            async move {
                // What is read of the sessions is read from their files.
                let encoded = tokio::task::spawn_blocking(move || {
                    let mut body = String::new();
                    prometheus_text::encode(&mut body, &registry).map(|()| body)
                })
                .await;
                match encoded {
                    Ok(Ok(body)) => (
                        [(header::CONTENT_TYPE, prometheus_text::CONTENT_TYPE)],
                        body,
                    )
                        .into_response(),
                    _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                }
            }
        }),
    );
    let listening = serving
        .listen
        .bind()
        .await
        .with_context(|| format!("failed to listen for metrics on {}", serving.listen))?;
    info!(listen = %serving.listen, "metrics served");
    Ok(listening.serve(routes, std::future::pending()))
}
