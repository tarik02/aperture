//! Recordings of a target, as files of the session. A recording takes the target's video as
//! it is encoded for those who watch it and writes it into a Matroska file, so recording
//! costs no second encoding. The pointer is drawn into the video while any recording runs.
//!
//! This is the raw video: what a target showed, from start to stop.
//!
//! Next to the video goes the recording's journal, a file with a JSON object a line for
//! what the session's automation did while the recording ran, for whatever makes something
//! of the video later. Every entry has a `kind`, `at_ms` and `end_ms`, in the video's time,
//! and:
//!
//! | kind      | fields                         |                                         |
//! |-----------|--------------------------------|-----------------------------------------|
//! | `call`    | `tool`, `ok`, `tab`            | a tool call that acts on a page         |
//! | `move`    | `x`, `y`                       | the pointer came to rest here           |
//! | `press`   | `x`, `y`, `button`, `count`    | a mouse button went down                |
//! | `wheel`   | `x`, `y`, `dx`, `dy`           | the wheel turned, by pixels             |
//! | `caption` | `text`                         | what the automation says it is doing    |
//!
//! Positions are in the target's logical pixels. What people do in the session is not
//! journaled, nor are keys, which may be secrets.

use std::{
    collections::HashMap,
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, bail};
use aperture_compositor::Handle;
use gstreamer::{self as gst, prelude::*};
use gstreamer_app as gst_app;
use serde::Serialize;
use serde_json::Value;
use tokio::{
    sync::{broadcast, oneshot, watch},
    task::JoinHandle,
    time::timeout,
};
use tracing::{info, warn};

use super::stream::{Packet, Streams, Subscription};
use crate::targets::Target;

/// Where recordings go, below the session's files.
const DIRECTORY: &str = "recordings";
/// How long the last frame gets to come when a recording is stopped.
const LAST_FRAME_WITHIN: Duration = Duration::from_secs(1);
const FINISH_WITHIN: gst::ClockTime = gst::ClockTime::from_seconds(10);
/// What a journal may grow to, which only a runaway recording reaches.
const JOURNAL_BUDGET: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Recording,
    Finished,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Recording {
    pub id: String,
    /// The target it is of.
    pub target: String,
    /// The file, relative to the session's files.
    pub file: String,
    /// The journal's file, relative to the session's files.
    pub journal: String,
    /// Journal entries that were left out, the journal having grown past its budget.
    pub journal_dropped: usize,
    pub state: State,
    pub started_at_ms: u64,
    /// Set once the recording ended.
    pub duration_ms: Option<u64>,
    pub bytes: Option<u64>,
    pub failure: Option<String>,
}

/// A recording's journal, see the module's description.
struct Journal {
    file: Mutex<(File, usize)>,
    /// When the video starts, on the compositor's clock; unset until its first frame.
    start: OnceLock<Duration>,
    dropped: AtomicUsize,
}

impl Journal {
    fn add(&self, kind: &str, started: Duration, ended: Duration, mut fields: Value) {
        // What happens before the first frame happens at the start of the video.
        let start = self.start.get().copied().unwrap_or(ended);
        fields["kind"] = kind.into();
        fields["at_ms"] = (started.saturating_sub(start).as_millis() as u64).into();
        fields["end_ms"] = (ended.saturating_sub(start).as_millis() as u64).into();
        let line = format!("{fields}\n");
        let mut file = self.file.lock().expect("not poisoned");
        if file.1 + line.len() > JOURNAL_BUDGET || file.0.write_all(line.as_bytes()).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        file.1 += line.len();
    }
}

struct Entry {
    recording: Recording,
    journal: Arc<Journal>,
    /// Present while it runs.
    running: Option<(oneshot::Sender<()>, JoinHandle<()>)>,
}

struct Inner {
    streams: Arc<Streams>,
    compositor: Handle,
    targets: watch::Receiver<Vec<Target>>,
    files: PathBuf,
    recordings: Mutex<HashMap<String, Entry>>,
    /// How many recordings run, for those who journal to ask cheaply.
    running: AtomicUsize,
}

#[derive(Clone)]
pub struct Recordings(Arc<Inner>);

impl Recordings {
    pub fn new(
        streams: Arc<Streams>,
        compositor: Handle,
        targets: watch::Receiver<Vec<Target>>,
        files: PathBuf,
    ) -> Self {
        Self(Arc::new(Inner {
            streams,
            compositor,
            targets,
            files,
            recordings: Mutex::default(),
            running: AtomicUsize::new(0),
        }))
    }

    /// Starts recording a target; the newest one when none is named.
    pub async fn start(&self, target: Option<&str>) -> anyhow::Result<Recording> {
        let inner = &self.0;
        let target = {
            let targets = inner.targets.borrow();
            match target {
                Some(id) => targets
                    .iter()
                    .find(|target| target.id.eq_ignore_ascii_case(id)),
                None => targets.last(),
            }
            .cloned()
            .context("no such target")?
        };
        let id = uuid::Uuid::now_v7().simple().to_string();
        let file = format!("{DIRECTORY}/{id}.mkv");
        let journal_file = format!("{DIRECTORY}/{id}.jsonl");
        let path = inner.files.join(&file);
        std::fs::create_dir_all(inner.files.join(DIRECTORY))?;
        let journal = Arc::new(Journal {
            file: Mutex::new((File::create(inner.files.join(&journal_file))?, 0)),
            start: OnceLock::new(),
            dropped: AtomicUsize::new(0),
        });

        let subscription = inner.streams.subscribe(target.window).await?;
        let writer = Writer::new(&path)?;
        let recording = Recording {
            id: id.clone(),
            target: target.id,
            file,
            journal: journal_file,
            journal_dropped: 0,
            state: State::Recording,
            started_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| since.as_millis() as u64),
            duration_ms: None,
            bytes: None,
            failure: None,
        };
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn({
            let recordings = self.clone();
            let id = id.clone();
            let journal = journal.clone();
            async move {
                let outcome = record(subscription, writer, stopped, &journal.start).await;
                recordings.ended(&id, &path, outcome);
            }
        });
        {
            let mut recordings = inner.recordings.lock().expect("not poisoned");
            recordings.insert(
                id.clone(),
                Entry {
                    recording: recording.clone(),
                    journal,
                    running: Some((stop, task)),
                },
            );
            self.draw_pointer(&recordings);
        }
        info!(recording = %id, target = %recording.target, "recording started");
        Ok(recording)
    }

    /// Stops a recording and waits until its file is complete.
    pub async fn stop(&self, id: &str) -> anyhow::Result<Recording> {
        let running = {
            let mut recordings = self.0.recordings.lock().expect("not poisoned");
            let entry = recordings.get_mut(id).context("no such recording")?;
            entry.running.take()
        };
        if let Some((stop, task)) = running {
            let _ = stop.send(());
            let _ = task.await;
        }
        self.0
            .recordings
            .lock()
            .expect("not poisoned")
            .get(id)
            .map(|entry| entry.recording.clone())
            .context("no such recording")
    }

    /// Stops every recording that runs, as the session ends.
    pub async fn stop_all(&self) {
        let running: Vec<String> = self
            .0
            .recordings
            .lock()
            .expect("not poisoned")
            .iter()
            .filter(|(_, entry)| entry.running.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for id in running {
            let _ = self.stop(&id).await;
        }
    }

    /// Now, on the clock journal entries are timed with.
    pub fn now(&self) -> Duration {
        self.0.compositor.elapsed()
    }

    /// Adds an entry to the journals of the recordings that run: those of `target`, or all
    /// of them for what is about no one target. It began at `started`, see [`Self::now`], and
    /// ends now.
    pub fn note(&self, target: Option<&str>, kind: &str, started: Duration, fields: Value) {
        if self.0.running.load(Ordering::Relaxed) == 0 {
            return;
        }
        let ended = self.now();
        let recordings = self.0.recordings.lock().expect("not poisoned");
        for entry in recordings.values() {
            let recording = &entry.recording;
            let about = target.is_none_or(|target| recording.target.eq_ignore_ascii_case(target));
            if recording.state == State::Recording && about {
                entry.journal.add(kind, started, ended, fields.clone());
            }
        }
    }

    pub fn list(&self) -> Vec<Recording> {
        let recordings = self.0.recordings.lock().expect("not poisoned");
        let mut list: Vec<Recording> = recordings
            .values()
            .map(|entry| entry.recording.clone())
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    fn ended(&self, id: &str, path: &Path, outcome: anyhow::Result<Duration>) {
        let mut recordings = self.0.recordings.lock().expect("not poisoned");
        if let Some(entry) = recordings.get_mut(id) {
            entry.running = None;
            let dropped = entry.journal.dropped.load(Ordering::Relaxed);
            let recording = &mut entry.recording;
            recording.journal_dropped = dropped;
            recording.bytes = std::fs::metadata(path).ok().map(|metadata| metadata.len());
            match outcome {
                Ok(duration) => {
                    recording.state = State::Finished;
                    recording.duration_ms = Some(duration.as_millis() as u64);
                    info!(recording = %id, ?duration, "recording finished");
                }
                Err(err) => {
                    recording.state = State::Failed;
                    recording.failure = Some(format!("{err:#}"));
                    warn!(recording = %id, "recording failed: {err:#}");
                }
            }
        }
        self.draw_pointer(&recordings);
    }

    /// The pointer is in the frames while anything records them.
    fn draw_pointer(&self, recordings: &HashMap<String, Entry>) {
        let recording = recordings
            .values()
            .filter(|entry| entry.recording.state == State::Recording)
            .count();
        self.0.running.store(recording, Ordering::Relaxed);
        self.0.compositor.draw_pointer(recording > 0);
    }
}

/// Writes the stream from its next keyframe until told to stop, or until the target's
/// window closes. Returns how long the recording is.
async fn record(
    mut subscription: Subscription,
    writer: Writer,
    mut stopped: oneshot::Receiver<()>,
    start: &OnceLock<Duration>,
) -> anyhow::Result<Duration> {
    let mut first = None;
    let mut last = Duration::ZERO;
    // Until a keyframe comes, at the start and after frames were missed, nothing that
    // comes can be decoded.
    let mut decodable = false;
    let start_once = |time| {
        let _ = start.set(time);
    };
    let mut write = |packet: &Packet, decodable: &mut bool| -> anyhow::Result<()> {
        *decodable |= packet.keyframe;
        if !*decodable {
            return Ok(());
        }
        let start = *first.get_or_insert(packet.time);
        start_once(start);
        last = packet.time.saturating_sub(start);
        writer.write(packet, last)
    };
    loop {
        tokio::select! {
            packet = subscription.packets.recv() => match packet {
                Ok(packet) => write(&packet, &mut decodable)?,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    decodable = false;
                    subscription.keyframe();
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = &mut stopped => {
                // A window at rest sent its last frame long ago: one more, stamped now,
                // makes the recording last until now.
                subscription.keyframe();
                let latest = async {
                    loop {
                        match subscription.packets.recv().await {
                            Ok(packet) if packet.keyframe => return Some(packet),
                            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                };
                if let Ok(Some(packet)) = timeout(LAST_FRAME_WITHIN, latest).await {
                    write(&packet, &mut decodable)?;
                }
                break;
            }
        }
    }
    if first.is_none() {
        bail!("the target showed nothing while it was recorded");
    }
    tokio::task::spawn_blocking(move || writer.finish()).await??;
    Ok(last)
}

/// A Matroska file being written.
struct Writer {
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
}

impl Writer {
    fn new(path: &Path) -> anyhow::Result<Self> {
        super::encode::init()?;
        let pipeline = gst::Pipeline::new();
        let src = gst_app::AppSrc::builder()
            .format(gst::Format::Time)
            .caps(
                &gst::Caps::builder("video/x-h264")
                    .field("stream-format", "byte-stream")
                    .field("alignment", "au")
                    .build(),
            )
            .build();
        let parse = gst::ElementFactory::make("h264parse").build()?;
        let mux = gst::ElementFactory::make("matroskamux").build()?;
        let sink = gst::ElementFactory::make("filesink")
            .property("location", path.to_str().context("the path is not UTF-8")?)
            .build()?;
        pipeline.add_many([src.upcast_ref(), &parse, &mux, &sink])?;
        gst::Element::link_many([src.upcast_ref(), &parse, &mux, &sink])?;
        pipeline
            .set_state(gst::State::Playing)
            .context("failed to start writing the recording")?;
        Ok(Self { pipeline, src })
    }

    fn write(&self, packet: &Packet, time: Duration) -> anyhow::Result<()> {
        let mut buffer = gst::Buffer::from_slice(packet.data.clone());
        {
            let buffer = buffer.get_mut().expect("the buffer was just made");
            buffer.set_pts(gst::ClockTime::from_nseconds(time.as_nanos() as u64));
            if !packet.keyframe {
                buffer.set_flags(gst::BufferFlags::DELTA_UNIT);
            }
        }
        self.src
            .push_buffer(buffer)
            .map_err(|err| anyhow::anyhow!("failed to write a frame: {err}"))?;
        Ok(())
    }

    /// Ends the file and waits until it is written out.
    fn finish(self) -> anyhow::Result<()> {
        self.src
            .end_of_stream()
            .map_err(|err| anyhow::anyhow!("failed to end the recording: {err}"))?;
        let bus = self.pipeline.bus().context("the pipeline has no bus")?;
        let message = bus.timed_pop_filtered(
            FINISH_WITHIN,
            &[gst::MessageType::Eos, gst::MessageType::Error],
        );
        match message.as_ref().map(|message| message.view()) {
            Some(gst::MessageView::Eos(_)) => Ok(()),
            Some(gst::MessageView::Error(err)) => bail!("{}", err.error()),
            _ => bail!("the recording was not written out in time"),
        }
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        // GStreamer leaks elements disposed outside NULL.
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}
