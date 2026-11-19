//! Recordings of a target, as files of the session. A recording takes the target's video as
//! it is encoded for those who watch it and writes it into a Matroska file, so recording
//! costs no second encoding. The pointer is drawn into the video while any recording runs.
//! The tab's sound goes into the file the same way, as the packets its listeners get, with
//! silence where it played nothing.
//!
//! That is the raw video: what a target showed, from start to stop. Once it stopped, the
//! edit (see [`edit`](super::edit)) makes a second video of it and its journal; the raw one
//! stays.
//!
//! Next to the video goes the recording's journal, a file with a JSON object a line for
//! what the session's automation did while the recording ran. Every entry has a `kind`,
//! `at_ms` and `end_ms`, in the video's time, and:
//!
//! | kind        | fields                                   |                                    |
//! |-------------|------------------------------------------|------------------------------------|
//! | `call`      | `tool`, `ok`, `tab`                      | a tool call that acts on a page    |
//! | `move`      | `x`, `y`                                 | the pointer came to rest here      |
//! | `press`     | `x`, `y`, `button`, `count`              | a mouse button went down           |
//! | `wheel`     | `x`, `y`, `dx`, `dy`                     | the wheel turned, by pixels        |
//! | `caption`   | `text`, `duration_ms`                    | a text to show for that long       |
//! | `focus`     | `rect`, `zoom`, `follow`, `track`, `ended` | a zoom, for as long as it lasted |
//! | `attention` | `x`, `y`, `radius`, `loops`              | the pointer circled here           |
//!
//! Positions are in the target's logical pixels. A focus's `rect` is where it began;
//! `follow` is `element` or `pointer` when it follows one, and `track` lists `{at_ms, rect}`
//! for where what it follows moved, `at_ms` counted from the focus's start (the pointer is
//! a rectangle without a size). What people do in the session is not journaled, nor are
//! keys, which may be secrets.

use std::{
    collections::HashMap,
    f64::consts::TAU,
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, bail, ensure};
use aperture_compositor::{Handle, Input};
use gstreamer::{self as gst, prelude::*};
use gstreamer_app as gst_app;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    sync::{broadcast, oneshot, watch},
    task::JoinHandle,
    time::{sleep, timeout},
};
use tracing::{info, warn};

use super::{
    edit::{
        self,
        plan::{Options, Pace, Video},
    },
    encode::{Format, Quality},
    sound::{self, Sound},
    stream::{Key, Packet, Streams, Subscription},
};
use crate::{cdp, targets::Target};

/// Where recordings go, below the session's files.
const DIRECTORY: &str = "recordings";
/// How long the last frame gets to come when a recording is stopped.
const LAST_FRAME_WITHIN: Duration = Duration::from_secs(1);
const FINISH_WITHIN: gst::ClockTime = gst::ClockTime::from_seconds(10);
/// What a journal may grow to, which only a runaway recording reaches.
const JOURNAL_BUDGET: usize = 8 * 1024 * 1024;

const CAPTION_MAX_CHARS: usize = 200;
const CAPTION_MS: (u64, u64, u64) = (3000, 200, 30_000);
const FOCUS_MAX_ZOOM: f64 = 4.0;
const FOCUS_MS: (u64, u64) = (200, 10_000);
/// A focus nobody reset zooms out after this.
const FOCUS_OPEN_FOR: Duration = Duration::from_secs(60);
/// How often an element a focus follows is looked at.
const FOCUS_TRACK_EVERY: Duration = Duration::from_millis(100);
const ATTENTION_MS: (u64, u64, u64) = (1200, 300, 5000);
const ATTENTION_RADIUS: (f64, f64, f64) = (40.0, 8.0, 300.0);
const ATTENTION_LOOPS: (u64, u64, u64) = (2, 1, 5);
const ATTENTION_STEP: Duration = Duration::from_millis(16);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Recording,
    Finished,
    Failed,
}

/// A recording as it is told, and as it is kept next to its files: the session knows its
/// recordings again when it next runs.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Recording {
    pub id: String,
    /// The target it is of, which is no target of a later run of the session.
    pub target: String,
    /// The page's title and address as the recording began.
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    /// The raw video's file, relative to the session's files.
    pub file: String,
    /// The journal's file, relative to the session's files.
    pub journal: String,
    /// A small picture of the target as the recording began; none where it had no
    /// picture yet.
    pub preview: Option<String>,
    /// Journal entries that were left out, the journal having grown past its budget.
    pub journal_dropped: usize,
    pub state: State,
    pub started_at_ms: u64,
    /// Set once the recording ended.
    pub duration_ms: Option<u64>,
    pub bytes: Option<u64>,
    pub failure: Option<String>,
    pub options: Options,
    /// The edit, once the recording stopped; none where there is no ffmpeg to make it.
    pub edit: Option<Edit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditState {
    Editing,
    Finished,
    Failed,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Edit {
    pub state: EditState,
    /// The edited video's file, relative to the session's files, once it is made.
    pub file: Option<String>,
    /// What happened, where in the raw video and where in the edited one.
    pub timeline: Option<String>,
    pub failure: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
}

/// What a focus zooms on.
pub enum Subject {
    /// A fixed area of the page's viewport.
    Rect(Rect),
    /// An element, which the zoom follows as the page moves.
    Selector(String),
    /// The pointer, which the zoom follows as automation moves it.
    Pointer,
}

/// Where attention is drawn to.
pub enum Place {
    Point { x: f64, y: f64 },
    Selector(String),
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

/// A focus that has not ended yet.
struct OpenFocus {
    /// Which focus of the recording it is, for those who would end it to tell it from the
    /// one that replaced it.
    serial: u64,
    started: Duration,
    rect: Rect,
    zoom: f64,
    follow: Option<&'static str>,
    track: Vec<Value>,
}

/// What the raw video turned out to be.
struct Raw {
    duration: Duration,
    /// When its frames that showed a change came, in its own time.
    changed_at_ms: Vec<i64>,
    size: (u32, u32),
}

struct Entry {
    recording: Recording,
    journal: Arc<Journal>,
    /// Present while it runs.
    running: Option<(oneshot::Sender<()>, JoinHandle<()>)>,
    focus: Option<OpenFocus>,
    focuses: u64,
    /// Where automation last put the pointer.
    pointer: Option<(f64, f64)>,
    editing: Option<JoinHandle<()>>,
}

/// What makes the edits.
pub struct Editor {
    /// ffmpeg; without it recordings are left raw.
    pub ffmpeg: Option<PathBuf>,
    /// Where ffmpeg may keep what it builds once.
    pub cache: PathBuf,
}

struct Inner {
    streams: Arc<Streams>,
    compositor: Handle,
    browser: cdp::Client,
    targets: watch::Receiver<Vec<Target>>,
    files: PathBuf,
    editor: Editor,
    sound: Arc<Sound>,
    /// Whether the session's tabs are recorded at all.
    allowed: bool,
    recordings: Mutex<HashMap<String, Entry>>,
    /// The recordings of the session's earlier runs, as their files tell.
    earlier: Vec<Recording>,
    /// How many recordings run, for those who journal to ask cheaply.
    running: AtomicUsize,
}

#[derive(Clone)]
pub struct Recordings(Arc<Inner>);

impl Recordings {
    pub fn new(
        streams: Arc<Streams>,
        compositor: Handle,
        browser: cdp::Client,
        targets: watch::Receiver<Vec<Target>>,
        files: PathBuf,
        editor: Editor,
        sound: Arc<Sound>,
        allowed: bool,
    ) -> Self {
        let earlier = restore(&files);
        Self(Arc::new(Inner {
            streams,
            compositor,
            browser,
            targets,
            files,
            earlier,
            editor,
            sound,
            allowed,
            recordings: Mutex::default(),
            running: AtomicUsize::new(0),
        }))
    }

    /// Starts recording a target; the newest one when none is named.
    pub async fn start(&self, target: Option<&str>, options: Options) -> anyhow::Result<Recording> {
        let inner = &self.0;
        if !inner.allowed {
            bail!("recordings are off for this session");
        }
        options.check().map_err(anyhow::Error::msg)?;
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

        // What moves in the picture is told by how much of it changed, which is counted
        // from its pixels.
        let pixels = inner.compositor.pixels(target.window).await?;
        let subscription = inner
            .streams
            .subscribe(Key {
                window: target.window,
                format: Format::H264,
                // A file is not a link: it takes the best there is.
                quality: Quality::Full,
                fps: None,
            })
            .await?;
        let writer = Writer::new(&path)?;
        let preview_file = format!("{DIRECTORY}/{id}.preview.png");
        let preview = match inner.compositor.screenshot(target.window).await {
            Ok(frame) => {
                let to = inner.files.join(&preview_file);
                let kept = tokio::task::spawn_blocking(move || {
                    std::fs::write(to, super::shots::preview(&frame)?)?;
                    anyhow::Ok(())
                });
                matches!(kept.await, Ok(Ok(()))).then_some(preview_file)
            }
            Err(_) => None,
        };
        let heard = Heard {
            packets: inner.sound.listen(),
            tab: target.browser_tab,
            clock: inner.sound.clone(),
            compositor: inner.compositor.clone(),
        };
        let recording = Recording {
            id: id.clone(),
            target: target.id,
            title: target.title,
            url: target.url,
            file,
            journal: journal_file,
            preview,
            journal_dropped: 0,
            state: State::Recording,
            started_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| since.as_millis() as u64),
            duration_ms: None,
            bytes: None,
            failure: None,
            options,
            edit: None,
        };
        let threshold = recording.options.motion_threshold;
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn({
            let recordings = self.clone();
            let id = id.clone();
            let journal = journal.clone();
            async move {
                let start = &journal.start;
                let outcome = record(subscription, heard, writer, stopped, start, threshold).await;
                drop(pixels);
                recordings.ended(&id, outcome);
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
                    focus: None,
                    focuses: 0,
                    pointer: None,
                    editing: None,
                },
            );
            self.count(&recordings);
        }
        keep(&inner.files, &recording);
        info!(recording = %id, target = %recording.target, "recording started");
        Ok(recording)
    }

    /// Stops a recording and waits until its raw video is complete. The edit, where there
    /// is one, goes on after.
    pub async fn stop(&self, id: &str) -> anyhow::Result<Recording> {
        let running = {
            let mut recordings = self.0.recordings.lock().expect("not poisoned");
            let entry = recordings.get_mut(id).context("no such recording")?;
            // While the video still runs, so that the zoom ends inside it.
            self.close_focus(entry, None, "stopped");
            entry.running.take()
        };
        if let Some((stop, task)) = running {
            let _ = stop.send(());
            let _ = task.await;
        }
        self.get(id)
    }

    pub fn get(&self, id: &str) -> anyhow::Result<Recording> {
        let recordings = self.0.recordings.lock().expect("not poisoned");
        let earlier = || self.0.earlier.iter().find(|recording| recording.id == id);
        recordings
            .get(id)
            .map(|entry| &entry.recording)
            .or_else(earlier)
            .cloned()
            .context("no such recording")
    }

    /// Stops every recording that runs and gives up on the edits, as the session ends.
    pub async fn stop_all(&self) {
        let running: Vec<String> = {
            let recordings = self.0.recordings.lock().expect("not poisoned");
            recordings
                .iter()
                .filter(|(_, entry)| entry.running.is_some())
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in running {
            let _ = self.stop(&id).await;
        }
        let mut recordings = self.0.recordings.lock().expect("not poisoned");
        for entry in recordings.values_mut() {
            if let Some(editing) = entry.editing.take() {
                editing.abort();
                if let Some(edit) = &mut entry.recording.edit {
                    edit.state = EditState::Failed;
                    edit.failure = Some("the session ended before the edit was made".into());
                }
                keep(&self.0.files, &entry.recording);
            }
        }
    }

    pub fn list(&self) -> Vec<Recording> {
        let recordings = self.0.recordings.lock().expect("not poisoned");
        let mut list: Vec<Recording> = recordings
            .values()
            .map(|entry| &entry.recording)
            .chain(&self.0.earlier)
            .cloned()
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    /// How automation is to act on a target: at the slowest pace its running recordings
    /// ask for; none when nothing records it.
    pub fn pace(&self, target: &str) -> Option<Pace> {
        if self.0.running.load(Ordering::Relaxed) == 0 {
            return None;
        }
        let recordings = self.0.recordings.lock().expect("not poisoned");
        recordings
            .values()
            .map(|entry| &entry.recording)
            .filter(|recording| recording.state == State::Recording)
            .filter(|recording| recording.target.eq_ignore_ascii_case(target))
            .map(|recording| recording.options.pace)
            .max()
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
        let pointer = match kind {
            "move" | "press" => fields["x"].as_f64().zip(fields["y"].as_f64()),
            _ => None,
        };
        let mut recordings = self.0.recordings.lock().expect("not poisoned");
        for entry in recordings.values_mut() {
            let recording = &entry.recording;
            let about = target.is_none_or(|target| recording.target.eq_ignore_ascii_case(target));
            if recording.state != State::Recording || !about {
                continue;
            }
            entry.journal.add(kind, started, ended, fields.clone());
            // A focus on the pointer follows it.
            if let Some((x, y)) = pointer {
                entry.pointer = Some((x, y));
                if let Some(focus) = &mut entry.focus
                    && focus.follow == Some("pointer")
                {
                    let at_ms = ended.saturating_sub(focus.started).as_millis() as u64;
                    focus
                        .track
                        .push(json!({ "at_ms": at_ms, "rect": { "x": x, "y": y } }));
                }
            }
        }
    }

    /// Shows a text in a recording's edit from now on, for `duration_ms`.
    pub fn caption(
        &self,
        id: Option<&str>,
        text: &str,
        duration_ms: Option<u64>,
    ) -> anyhow::Result<()> {
        let text = text.trim();
        let length = text.chars().count();
        ensure!(
            (1..=CAPTION_MAX_CHARS).contains(&length),
            "text must be 1 to {CAPTION_MAX_CHARS} characters"
        );
        let duration_ms = bounded(duration_ms, CAPTION_MS)?;
        let (id, _) = self.pick(id)?;
        let now = self.now();
        let recordings = self.0.recordings.lock().expect("not poisoned");
        let entry = recordings.get(&id).context("no such recording")?;
        let fields = json!({ "text": text, "duration_ms": duration_ms });
        entry.journal.add("caption", now, now, fields);
        Ok(())
    }

    /// Zooms a recording's edit on `subject`, until it is reset, replaced by another focus,
    /// the recording stops or a minute passes; or for `duration_ms`, which this then waits
    /// for.
    pub async fn focus(
        &self,
        id: Option<&str>,
        subject: Subject,
        zoom: f64,
        duration_ms: Option<u64>,
    ) -> anyhow::Result<()> {
        ensure!(
            zoom > 1.0 && zoom <= FOCUS_MAX_ZOOM,
            "zoom must be above 1 and at most {FOCUS_MAX_ZOOM}"
        );
        if let Some(duration) = duration_ms {
            ensure!(
                (FOCUS_MS.0..=FOCUS_MS.1).contains(&duration),
                "duration_ms must be {} to {}",
                FOCUS_MS.0,
                FOCUS_MS.1
            );
        }
        let (id, target) = self.pick(id)?;
        let (rect, follow, selector) = match subject {
            Subject::Rect(rect) => (rect, None, None),
            Subject::Selector(selector) => {
                let rect = self
                    .measure(&target, &selector)
                    .await?
                    .context("the selector matched no element")?;
                (rect, Some("element"), Some(selector))
            }
            Subject::Pointer => (
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 0.0,
                },
                Some("pointer"),
                None,
            ),
        };

        let serial = {
            let mut recordings = self.0.recordings.lock().expect("not poisoned");
            let entry = recordings.get_mut(&id).context("no such recording")?;
            ensure!(
                entry.recording.state == State::Recording,
                "the recording stopped"
            );
            self.close_focus(entry, None, "replaced");
            entry.focuses += 1;
            // The pointer is where automation last put it; before it moved, in the middle.
            let rect = match (follow, entry.pointer) {
                (Some("pointer"), Some((x, y))) => Rect { x, y, ..rect },
                (Some("pointer"), None) => self.middle(&target).unwrap_or(rect),
                _ => rect,
            };
            entry.focus = Some(OpenFocus {
                serial: entry.focuses,
                started: self.now(),
                rect,
                zoom,
                follow,
                track: Vec::new(),
            });
            entry.focuses
        };

        if let Some(selector) = selector {
            tokio::spawn(self.clone().track(id.clone(), serial, target, selector));
        }
        match duration_ms {
            Some(duration) => {
                sleep(Duration::from_millis(duration)).await;
                self.end_focus(&id, Some(serial), "duration");
            }
            None => {
                let recordings = self.clone();
                tokio::spawn(async move {
                    sleep(FOCUS_OPEN_FOR).await;
                    recordings.end_focus(&id, Some(serial), "expired");
                });
            }
        }
        Ok(())
    }

    /// Zooms a recording's edit out of its focus.
    pub fn reset_focus(&self, id: Option<&str>) -> anyhow::Result<()> {
        let (id, _) = self.pick(id)?;
        self.end_focus(&id, None, "reset");
        Ok(())
    }

    /// Circles the pointer around a place, so that whoever watches the recording looks
    /// there. It waits until the pointer is done.
    pub async fn attention(
        &self,
        id: Option<&str>,
        place: Place,
        radius: Option<f64>,
        loops: Option<u64>,
        duration_ms: Option<u64>,
    ) -> anyhow::Result<()> {
        let radius = radius.unwrap_or(ATTENTION_RADIUS.0);
        ensure!(
            (ATTENTION_RADIUS.1..=ATTENTION_RADIUS.2).contains(&radius),
            "radius must be {} to {}",
            ATTENTION_RADIUS.1,
            ATTENTION_RADIUS.2
        );
        let loops = bounded(loops, ATTENTION_LOOPS).map_err(|_| {
            anyhow::anyhow!(
                "loops must be {} to {}",
                ATTENTION_LOOPS.1,
                ATTENTION_LOOPS.2
            )
        })?;
        let duration = Duration::from_millis(bounded(duration_ms, ATTENTION_MS)?);
        let (id, target) = self.pick(id)?;
        let (x, y) = match place {
            Place::Point { x, y } => (x, y),
            Place::Selector(selector) => {
                let rect = self
                    .measure(&target, &selector)
                    .await?
                    .context("the selector matched no element")?;
                (rect.x + rect.width / 2.0, rect.y + rect.height / 2.0)
            }
        };
        let window = {
            let targets = self.0.targets.borrow();
            let shown = targets.iter().find(|shown| shown.id == target);
            shown
                .map(|shown| shown.window)
                .context("the recorded target is gone")?
        };

        let started = self.now();
        let begun = tokio::time::Instant::now();
        loop {
            let turned = (begun.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0);
            let angle = TAU * loops as f64 * turned;
            self.0.compositor.input(Input::PointerMotion {
                window,
                x: x + radius * angle.cos(),
                y: y + radius * angle.sin(),
            });
            if turned >= 1.0 {
                break;
            }
            sleep(ATTENTION_STEP).await;
        }
        let fields = json!({ "x": x, "y": y, "radius": radius, "loops": loops });
        let recordings = self.0.recordings.lock().expect("not poisoned");
        if let Some(entry) = recordings.get(&id) {
            entry.journal.add("attention", started, self.now(), fields);
        }
        Ok(())
    }

    /// The recording an annotation is for: the one named, or the only one that runs. Also
    /// the target it records.
    fn pick(&self, id: Option<&str>) -> anyhow::Result<(String, String)> {
        let recordings = self.0.recordings.lock().expect("not poisoned");
        let mut running = recordings
            .values()
            .map(|entry| &entry.recording)
            .filter(|recording| recording.state == State::Recording)
            .filter(|recording| id.is_none_or(|id| recording.id == id));
        match (running.next(), running.next()) {
            (Some(recording), None) => Ok((recording.id.clone(), recording.target.clone())),
            (None, _) => bail!("no such recording is running"),
            (Some(_), Some(_)) => {
                bail!("several recordings are running: pass the recording's `id`")
            }
        }
    }

    fn end_focus(&self, id: &str, serial: Option<u64>, reason: &str) {
        let mut recordings = self.0.recordings.lock().expect("not poisoned");
        if let Some(entry) = recordings.get_mut(id) {
            self.close_focus(entry, serial, reason);
        }
    }

    /// Ends the recording's focus and journals it; with `serial`, only when it is still
    /// that one.
    fn close_focus(&self, entry: &mut Entry, serial: Option<u64>, reason: &str) {
        if serial
            .is_some_and(|serial| entry.focus.as_ref().map(|focus| focus.serial) != Some(serial))
        {
            return;
        }
        let Some(focus) = entry.focus.take() else {
            return;
        };
        let fields = json!({
            "rect": focus.rect,
            "zoom": focus.zoom,
            "follow": focus.follow,
            "track": focus.track,
            "ended": reason,
        });
        entry
            .journal
            .add("focus", focus.started, self.now(), fields);
    }

    /// Follows the element a focus is on for as long as the focus lasts, noting where it
    /// moved to.
    async fn track(self, id: String, serial: u64, target: String, selector: String) {
        let Ok(probe) = Probe::attach(&self.0.browser, &target).await else {
            return;
        };
        let mut last = None;
        loop {
            sleep(FOCUS_TRACK_EVERY).await;
            // The page may be navigating: a look that fails is no end of the focus.
            let rect = probe.rect(&selector).await.ok().flatten();
            let mut recordings = self.0.recordings.lock().expect("not poisoned");
            let focus = recordings
                .get_mut(&id)
                .and_then(|entry| entry.focus.as_mut())
                .filter(|focus| focus.serial == serial);
            let Some(focus) = focus else {
                break;
            };
            if let Some(rect) = rect {
                let moved = (rect.x, rect.y, rect.width, rect.height);
                if last.replace(moved) != Some(moved) {
                    let at_ms = self.now().saturating_sub(focus.started).as_millis() as u64;
                    focus.track.push(json!({ "at_ms": at_ms, "rect": rect }));
                }
            }
        }
        probe.detach().await;
    }

    /// Where an element is in the target's viewport; none when there is no such element.
    async fn measure(&self, target: &str, selector: &str) -> anyhow::Result<Option<Rect>> {
        let probe = Probe::attach(&self.0.browser, target).await?;
        let rect = probe.rect(selector).await;
        probe.detach().await;
        rect
    }

    /// The middle of the target's viewport, as a rectangle without a size.
    fn middle(&self, target: &str) -> Option<Rect> {
        let targets = self.0.targets.borrow();
        let shown = targets.iter().find(|shown| shown.id == target)?;
        Some(Rect {
            x: f64::from(shown.width) / 2.0,
            y: f64::from(shown.height) / 2.0,
            width: 0.0,
            height: 0.0,
        })
    }

    /// Takes in how a recording's raw video ended, and starts its edit.
    fn ended(&self, id: &str, outcome: anyhow::Result<Raw>) {
        let inner = &self.0;
        let mut recordings = inner.recordings.lock().expect("not poisoned");
        if let Some(entry) = recordings.get_mut(id) {
            // The target's window closed under it.
            self.close_focus(entry, None, "stopped");
            entry.running = None;
            let dropped = entry.journal.dropped.load(Ordering::Relaxed);
            let recording = &mut entry.recording;
            let video = inner.files.join(&recording.file);
            recording.journal_dropped = dropped;
            recording.bytes = std::fs::metadata(&video)
                .ok()
                .map(|metadata| metadata.len());
            match outcome {
                Ok(raw) => {
                    recording.state = State::Finished;
                    recording.duration_ms = Some(raw.duration.as_millis() as u64);
                    info!(recording = %id, duration = ?raw.duration, "recording finished");
                    if let Some(ffmpeg) = &inner.editor.ffmpeg {
                        recording.edit = Some(Edit {
                            state: EditState::Editing,
                            file: None,
                            timeline: None,
                            failure: None,
                        });
                        let (edited, timeline) = edit::outputs(&video);
                        let job = edit::Job {
                            ffmpeg: ffmpeg.clone(),
                            journal: inner.files.join(&recording.journal),
                            work: video.with_extension("edit"),
                            cache: inner.editor.cache.clone(),
                            options: recording.options.clone(),
                            changed_at_ms: raw.changed_at_ms,
                            frame: Video {
                                duration_ms: raw.duration.as_millis() as i64,
                                width: raw.size.0,
                                height: raw.size.1,
                            },
                            dropped,
                            video,
                            edited,
                            timeline,
                        };
                        let recordings = self.clone();
                        let id = id.to_owned();
                        entry.editing = Some(tokio::spawn(async move {
                            let made = edit::run(job).await;
                            recordings.edited(&id, made);
                        }));
                    }
                }
                Err(err) => {
                    recording.state = State::Failed;
                    recording.failure = Some(format!("{err:#}"));
                    warn!(recording = %id, "recording failed: {err:#}");
                }
            }
            keep(&inner.files, &entry.recording);
        }
        self.count(&recordings);
    }

    fn edited(&self, id: &str, made: anyhow::Result<()>) {
        let mut recordings = self.0.recordings.lock().expect("not poisoned");
        let Some(entry) = recordings.get_mut(id) else {
            return;
        };
        entry.editing = None;
        let stem = entry.recording.file.trim_end_matches(".mkv").to_owned();
        let Some(edit) = &mut entry.recording.edit else {
            return;
        };
        match made {
            Ok(()) => {
                edit.state = EditState::Finished;
                edit.file = Some(format!("{stem}.edited.mp4"));
                edit.timeline = Some(format!("{stem}.timeline.json"));
                info!(recording = %id, "recording edited");
            }
            Err(err) => {
                edit.state = EditState::Failed;
                edit.failure = Some(format!("{err:#}"));
                warn!(recording = %id, "recording edit failed: {err:#}");
            }
        }
        keep(&self.0.files, &entry.recording);
    }

    /// Takes count of the recordings that run. The pointer is in the frames while any does.
    fn count(&self, recordings: &HashMap<String, Entry>) {
        let recording = recordings
            .values()
            .filter(|entry| entry.recording.state == State::Recording)
            .count();
        self.0.running.store(recording, Ordering::Relaxed);
        self.0.compositor.draw_pointer(recording > 0);
    }
}

/// A value an annotation gives or leaves to its default, within its bounds.
/// Where what is told of a recording is kept, next to its files.
fn kept_path(files: &Path, id: &str) -> PathBuf {
    files.join(DIRECTORY).join(format!("{id}.recording.json"))
}

/// Keeps what is told of a recording, whole or not at all.
fn keep(files: &Path, recording: &Recording) {
    let path = kept_path(files, &recording.id);
    let partial = path.with_extension("part");
    let written = serde_json::to_vec_pretty(recording)
        .map_err(std::io::Error::other)
        .and_then(|told| std::fs::write(&partial, told))
        .and_then(|()| std::fs::rename(&partial, &path));
    if let Err(err) = written {
        warn!(recording = %recording.id, "a recording was not kept for the next run: {err}");
    }
}

/// The recordings the session's earlier runs kept. One that was still being made or
/// edited when its run ended is told as failed: nothing goes on with it.
fn restore(files: &Path) -> Vec<Recording> {
    let Ok(entries) = std::fs::read_dir(files.join(DIRECTORY)) else {
        return Vec::new();
    };
    let mut earlier = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().ends_with(".recording.json") {
            continue;
        }
        let read = std::fs::read(entry.path())
            .map_err(anyhow::Error::from)
            .and_then(|kept| Ok(serde_json::from_slice::<Recording>(&kept)?));
        let mut recording = match read {
            Ok(recording) => recording,
            Err(err) => {
                warn!(file = ?name, "a kept recording is not read: {err:#}");
                continue;
            }
        };
        let mut changed = false;
        if recording.state == State::Recording {
            recording.state = State::Failed;
            recording.failure = Some("the session ended while it was recorded".into());
            recording.bytes = std::fs::metadata(files.join(&recording.file))
                .ok()
                .map(|metadata| metadata.len());
            changed = true;
        }
        if let Some(edit) = &mut recording.edit
            && edit.state == EditState::Editing
        {
            edit.state = EditState::Failed;
            edit.failure = Some("the session ended before the edit was made".into());
            changed = true;
        }
        if changed {
            keep(files, &recording);
        }
        earlier.push(recording);
    }
    earlier
}

fn bounded(value: Option<u64>, (default, low, high): (u64, u64, u64)) -> anyhow::Result<u64> {
    let value = value.unwrap_or(default);
    ensure!(
        (low..=high).contains(&value),
        "duration_ms must be {low} to {high}"
    );
    Ok(value)
}

/// A DevTools session on a target, for looking at where its elements are.
struct Probe<'a> {
    browser: &'a cdp::Client,
    session: String,
}

impl<'a> Probe<'a> {
    async fn attach(browser: &'a cdp::Client, target: &str) -> anyhow::Result<Self> {
        let attached = browser
            .call(
                "Target.attachToTarget",
                json!({ "targetId": target, "flatten": true }),
            )
            .await?;
        let session = attached["sessionId"]
            .as_str()
            .context("the browser attached no session")?
            .to_owned();
        Ok(Self { browser, session })
    }

    async fn rect(&self, selector: &str) -> anyhow::Result<Option<Rect>> {
        let selector = serde_json::to_string(selector)?;
        let expression = format!(
            "(() => {{ const e = document.querySelector({selector}); if (!e) return null; \
             const r = e.getBoundingClientRect(); \
             return {{ x: r.x, y: r.y, width: r.width, height: r.height }}; }})()"
        );
        let evaluated = self
            .browser
            .call_in(
                Some(&self.session),
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await?;
        ensure!(
            evaluated.get("exceptionDetails").is_none(),
            "the selector is not valid"
        );
        Ok(serde_json::from_value(evaluated["result"]["value"].clone()).ok())
    }

    async fn detach(self) {
        let detach = json!({ "sessionId": self.session });
        let _ = self.browser.call("Target.detachFromTarget", detach).await;
    }
}

/// The sound of the tab a recording is of.
struct Heard {
    packets: sound::Listener,
    tab: i64,
    /// What the packets are stamped by, and what the video's are.
    clock: Arc<Sound>,
    compositor: Handle,
}

/// An Opus packet that plays as silence.
const SILENCE: [u8; 3] = [0xf8, 0xff, 0xfe];

/// How far behind the present the file's sound is left open for a packet that is on its
/// way, and how often what stayed empty is filled with silence.
const SOUND_BEHIND: Duration = Duration::from_millis(200);
const SOUND_FILL_EVERY: Duration = Duration::from_millis(200);

/// Writes the stream from its next keyframe until told to stop, or until the target's
/// window closes.
async fn record(
    mut subscription: Subscription,
    mut heard: Heard,
    writer: Writer,
    mut stopped: oneshot::Receiver<()>,
    start: &OnceLock<Duration>,
    motion_threshold: f64,
) -> anyhow::Result<Raw> {
    let mut first = None;
    let mut last = Duration::ZERO;
    let mut changed_at_ms = Vec::new();
    let mut size = (0, 0);
    // Until a keyframe comes, at the start and after frames were missed, nothing that
    // comes can be decoded.
    let mut decodable = false;
    let mut write = |packet: &Packet, decodable: &mut bool| -> anyhow::Result<()> {
        *decodable |= packet.keyframe;
        if !*decodable {
            return Ok(());
        }
        let began = *first.get_or_insert(packet.time);
        let _ = start.set(began);
        last = packet.time.saturating_sub(began);
        if size == (0, 0) {
            size = packet.size;
        }
        // Something happened where enough of the picture changed.
        let whole = f64::from(packet.size.0) * f64::from(packet.size.1);
        if packet.changed > 0 && packet.changed as f64 >= whole * motion_threshold {
            changed_at_ms.push(last.as_millis() as i64);
        }
        writer.write(packet, last)
    };
    let samples = u64::from(sound::RATE) * sound::PACKET.as_millis() as u64 / 1000;
    let in_samples = |time: Duration| time.as_micros() as u64 * u64::from(sound::RATE) / 1_000_000;
    // The sound's time at the video's start, once it started, and how far the file's
    // sound reaches, in samples of the video's time. The file's sound has no holes: the
    // file is written as far as both of its tracks reach.
    let mut sound_start = None;
    let mut sound_end = 0;
    let silence_until = |end: u64, sound_end: &mut u64| -> anyhow::Result<()> {
        while *sound_end + samples <= end {
            writer.play(&SILENCE, *sound_end)?;
            *sound_end += samples;
        }
        Ok(())
    };
    let mut fill = tokio::time::interval(SOUND_FILL_EVERY);
    loop {
        tokio::select! {
            packet = subscription.packets.recv() => match packet {
                Ok(packet) => {
                    write(&packet, &mut decodable)?;
                    if decodable && sound_start.is_none() {
                        // The frame is of a moment ago.
                        let ago = heard.compositor.elapsed().saturating_sub(packet.time);
                        sound_start = Some(heard.clock.now().saturating_sub(in_samples(ago)));
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    decodable = false;
                    subscription.keyframe();
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            packet = heard.packets.next(Some(heard.tab)) => {
                // What was missed is silence; what came before the video is left out.
                let at = packet.ok().zip(sound_start).and_then(|(packet, start)| {
                    Some((packet.at.checked_sub(start)?, packet))
                });
                if let Some((at, packet)) = at {
                    silence_until(at, &mut sound_end)?;
                    writer.play(&packet.data, sound_end)?;
                    sound_end += samples;
                }
            }
            _ = fill.tick() => {
                if let Some(start) = sound_start {
                    let open = heard.clock.now().saturating_sub(start + in_samples(SOUND_BEHIND));
                    silence_until(open, &mut sound_end)?;
                }
            }
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
    silence_until(in_samples(last), &mut sound_end)?;
    tokio::task::spawn_blocking(move || writer.finish()).await??;
    Ok(Raw {
        duration: last,
        changed_at_ms,
        size,
    })
}

/// A Matroska file being written.
struct Writer {
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
    sound: gst_app::AppSrc,
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
        let sound = gst_app::AppSrc::builder()
            .format(gst::Format::Time)
            .caps(
                &gst::Caps::builder("audio/x-opus")
                    .field("rate", sound::RATE as i32)
                    .field("channels", 2)
                    .field("channel-mapping-family", 0)
                    .field("stream-count", 1)
                    .field("coupled-count", 1)
                    .build(),
            )
            .build();
        pipeline.add_many([src.upcast_ref(), &parse, &mux, &sink, sound.upcast_ref()])?;
        gst::Element::link_many([src.upcast_ref(), &parse, &mux, &sink])?;
        // By name: left to choose, the muxer takes it for another picture.
        let into = mux
            .request_pad_simple("audio_%u")
            .context("the muxer takes no sound")?;
        sound
            .static_pad("src")
            .context("the sound has no pad")?
            .link(&into)?;
        pipeline
            .set_state(gst::State::Playing)
            .context("failed to start writing the recording")?;
        Ok(Self {
            pipeline,
            src,
            sound,
        })
    }

    /// Writes an Opus packet that plays after `at` samples of the video.
    fn play(&self, data: &[u8], at: u64) -> anyhow::Result<()> {
        let rate = u64::from(sound::RATE);
        let mut buffer = gst::Buffer::from_slice(data.to_vec());
        {
            let buffer = buffer.get_mut().expect("the buffer was just made");
            buffer.set_pts(gst::ClockTime::from_nseconds(at * 1_000_000_000 / rate));
            buffer.set_duration(gst::ClockTime::from_nseconds(
                sound::PACKET.as_nanos() as u64
            ));
        }
        self.sound
            .push_buffer(buffer)
            .map_err(|err| anyhow::anyhow!("failed to write the sound: {err}"))?;
        Ok(())
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
        for src in [&self.src, &self.sound] {
            src.end_of_stream()
                .map_err(|err| anyhow::anyhow!("failed to end the recording: {err}"))?;
        }
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
