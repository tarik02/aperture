//! Recordings of a target, as files of the session. A recording takes the target's video as
//! it is encoded for those who watch it and writes it into a Matroska file, so recording
//! costs no second encoding. The pointer is drawn into the video while any recording runs.
//! The tab's sound goes into the file the same way, as the packets its listeners get, with
//! silence where it played nothing. The picture's size is not fixed: it changes in the file
//! as the target's does, and as the recording goes on with a tab of another size.
//!
//! That is the raw video: what a target showed, from start to stop. Once it stopped, the
//! edit (see [`edit`](super::edit)) makes a second video of it and its journal, as whoever
//! stopped it said; the raw one stays, and the edit is made of it again, with other options,
//! for as long as it does.
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

mod annotate;
mod capture;
mod kept;

use std::{
    collections::HashMap,
    fs::File,
    future::Future,
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use aperture_compositor::{Frame, Handle};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use tracing::{info, warn};

pub use self::annotate::Annotation;
use self::annotate::Rect;
use self::capture::{Heard, Moved, Writer};
use super::{
    edit::{self, Raw, plan::Options},
    encode::{Format, Quality},
    shots,
    sound::Sound,
    stream::{Key, Streams},
};
use crate::{cdp, targets::Target};

/// Where recordings go, below the session's files.
const DIRECTORY: &str = "recordings";
/// What a journal may grow to, which only a runaway recording reaches.
const JOURNAL_BUDGET: usize = 8 * 1024 * 1024;

/// Why a recording is not started, stopped or told.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("recordings are off for this session")]
    Off,
    #[error("no such target")]
    NoTarget,
    #[error("no such recording")]
    NoRecording,
    #[error("{0}")]
    Options(String),
    /// The recording is not one that this is done to.
    #[error("{0}")]
    State(String),
    #[error(transparent)]
    Failed(#[from] anyhow::Error),
}

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
    /// The tab it is of.
    pub tab: u32,
    /// The target it is of, which is no target of a later run of the session.
    pub target: String,
    /// The page's title and address as the recording began.
    pub title: String,
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
    /// It goes on with whichever tab the session's automation acts on.
    #[serde(default)]
    pub follow: bool,
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
    /// What it is made with: what the recording was stopped with, or what it was last
    /// edited again with.
    #[serde(default)]
    pub options: Options,
    /// When it was made, which tells one edit of a recording from the one before.
    #[serde(default)]
    pub made_at_ms: Option<u64>,
    /// The edited video's file, relative to the session's files, once it is made.
    pub file: Option<String>,
    /// What happened, where in the raw video and where in the edited one.
    pub timeline: Option<String>,
    pub failure: Option<String>,
}

/// A recording's journal, see the module's description.
struct Journal {
    file: Mutex<(File, usize)>,
    /// When the video starts, on the compositor's clock; unset until its first frame.
    start: OnceLock<Duration>,
    /// Entries that were left out: past the budget, or not written.
    dropped: AtomicUsize,
    /// Writing failed, and was said to.
    unwritten: AtomicBool,
}

impl Journal {
    fn create(path: &std::path::Path) -> std::io::Result<Self> {
        Ok(Self {
            file: Mutex::new((File::create(path)?, 0)),
            start: OnceLock::new(),
            dropped: AtomicUsize::new(0),
            unwritten: AtomicBool::new(false),
        })
    }

    fn add(&self, kind: &str, started: Duration, ended: Duration, mut fields: Value) {
        // What happens before the first frame happens at the start of the video.
        let start = self.start.get().copied().unwrap_or(ended);
        fields["kind"] = kind.into();
        fields["at_ms"] = (started.saturating_sub(start).as_millis() as u64).into();
        fields["end_ms"] = (ended.saturating_sub(start).as_millis() as u64).into();
        let line = format!("{fields}\n");
        let mut file = self.file.lock().expect("not poisoned");
        if file.1 + line.len() > JOURNAL_BUDGET {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if let Err(err) = file.0.write_all(line.as_bytes()) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            if !self.unwritten.swap(true, Ordering::Relaxed) {
                warn!(%err, "a recording's journal is not written");
            }
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

struct Entry {
    recording: Recording,
    journal: Arc<Journal>,
    /// Present while it runs.
    running: Option<(oneshot::Sender<()>, JoinHandle<()>)>,
    /// Takes another tab for the recording to go on with, while it runs.
    moves: mpsc::UnboundedSender<Moved>,
    focus: Option<OpenFocus>,
    focuses: u64,
    /// Where automation last put the pointer.
    pointer: Option<(f64, f64)>,
    /// What it was stopped with, for the edit made as its raw video ends.
    stopped_with: Options,
    editing: Option<JoinHandle<()>>,
}

/// A recording of an earlier run of the session.
struct Earlier {
    recording: Recording,
    editing: Option<JoinHandle<()>>,
}

/// What makes the edits.
pub struct Editor {
    /// ffmpeg; without it recordings are left raw.
    pub ffmpeg: Option<PathBuf>,
    /// Where ffmpeg may keep what it builds once.
    pub cache: PathBuf,
}

/// What recordings are made of.
pub struct Sources {
    pub streams: Arc<Streams>,
    pub compositor: Handle,
    pub browser: cdp::Client,
    pub targets: watch::Receiver<Vec<Target>>,
    pub sound: Arc<Sound>,
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
    earlier: Mutex<HashMap<String, Earlier>>,
    /// How many recordings run, for those who journal to ask cheaply.
    running: AtomicUsize,
}

#[derive(Clone)]
pub struct Recordings(Arc<Inner>);

impl Recordings {
    /// Recordings in the session's files, with those its earlier runs kept there. With
    /// `allowed` off none is started.
    pub fn new(sources: Sources, files: PathBuf, editor: Editor, allowed: bool) -> Self {
        let earlier = kept::restore(&files).into_iter().map(|recording| {
            let earlier = Earlier {
                recording,
                editing: None,
            };
            (earlier.recording.id.clone(), earlier)
        });
        let earlier = Mutex::new(earlier.collect());
        let Sources {
            streams,
            compositor,
            browser,
            targets,
            sound,
        } = sources;
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

    /// Starts recording a target; the newest one when none is named. With `follow` it goes
    /// on with whichever tab the session's automation acts on.
    pub async fn start(&self, target: Option<&str>, follow: bool) -> Result<Recording, Error> {
        if !self.0.allowed {
            return Err(Error::Off);
        }
        let target = {
            let targets = self.0.targets.borrow();
            match target {
                Some(named) => crate::targets::named(&targets, named),
                None => targets.last(),
            }
            .cloned()
            .ok_or(Error::NoTarget)?
        };
        Ok(self.begin(target, follow).await?)
    }

    async fn begin(&self, target: Target, follow: bool) -> anyhow::Result<Recording> {
        let inner = &self.0;
        let id = uuid::Uuid::now_v7().simple().to_string();
        let file = format!("{DIRECTORY}/{id}.mkv");
        let journal_file = format!("{DIRECTORY}/{id}.jsonl");
        std::fs::create_dir_all(inner.files.join(DIRECTORY))?;
        let journal = Arc::new(Journal::create(&inner.files.join(&journal_file))?);

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
        let writer = Writer::new(&inner.files.join(&file))?;
        let preview = match inner.compositor.screenshot(target.window).await {
            Ok(frame) => self.preview(&id, frame).await,
            // A target that has shown nothing yet.
            Err(aperture_compositor::Error::NoContent(_)) => None,
            Err(err) => {
                warn!(recording = %id, %err, "a recording has no preview");
                None
            }
        };
        let heard = Heard {
            packets: inner.sound.listen(),
            clock: inner.sound.clone(),
            compositor: inner.compositor.clone(),
        };
        let recording = Recording {
            id: id.clone(),
            tab: target.tab,
            target: target.id,
            title: target.title,
            url: target.url,
            file,
            journal: journal_file,
            preview,
            journal_dropped: 0,
            state: State::Recording,
            started_at_ms: now_ms(),
            duration_ms: None,
            bytes: None,
            failure: None,
            follow,
            edit: None,
        };
        let (stop, stopped) = oneshot::channel();
        let (moves, moved) = mpsc::unbounded_channel();
        let tab = target.browser_tab;
        let task = tokio::spawn({
            let recordings = self.clone();
            let id = id.clone();
            let journal = journal.clone();
            async move {
                let on = Moved {
                    subscription,
                    pixels,
                    tab,
                };
                let made = capture::record(on, heard, writer, stopped, moved, journal);
                recordings.ended(&id, finished(made).await);
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
                    moves,
                    focus: None,
                    focuses: 0,
                    pointer: None,
                    stopped_with: Options::default(),
                    editing: None,
                },
            );
            self.count(&recordings);
        }
        kept::keep(&inner.files, &recording);
        info!(recording = %id, target = %recording.target, "recording started");
        Ok(recording)
    }

    /// Keeps a small picture of the target as the recording begins, and gives its file.
    async fn preview(&self, id: &str, frame: Frame) -> Option<String> {
        let file = format!("{DIRECTORY}/{id}.preview.png");
        let to = self.0.files.join(&file);
        let kept = tokio::task::spawn_blocking(move || {
            std::fs::write(to, shots::preview(&frame)?)?;
            anyhow::Ok(())
        });
        match kept.await.map_err(anyhow::Error::from).flatten() {
            Ok(()) => Some(file),
            Err(err) => {
                warn!(recording = %id, "a recording has no preview: {err:#}");
                None
            }
        }
    }

    /// Has a running recording go on with another tab: the video goes on in the same
    /// file, with the tab's picture from its next frame, at the size it has, and its sound.
    pub async fn retarget(&self, id: &str, target: &str) -> Result<Recording, Error> {
        let inner = &self.0;
        let to = {
            let recordings = inner.recordings.lock().expect("not poisoned");
            let entry = recordings.get(id).ok_or(Error::NoRecording)?;
            if entry.recording.state != State::Recording || entry.running.is_none() {
                return Err(Error::State("the recording does not run".into()));
            }
            let targets = inner.targets.borrow();
            let to = crate::targets::named(&targets, target).ok_or(Error::NoTarget)?;
            if to.id.eq_ignore_ascii_case(&entry.recording.target) {
                return Ok(entry.recording.clone());
            }
            to.clone()
        };
        let moved = Moved {
            pixels: inner
                .compositor
                .pixels(to.window)
                .await
                .map_err(anyhow::Error::from)?,
            subscription: inner
                .streams
                .subscribe(Key {
                    window: to.window,
                    format: Format::H264,
                    quality: Quality::Full,
                    fps: None,
                })
                .await
                .map_err(anyhow::Error::from)?,
            tab: to.browser_tab,
        };
        let now = self.now();
        let mut recordings = inner.recordings.lock().expect("not poisoned");
        let entry = recordings.get_mut(id).ok_or(Error::NoRecording)?;
        // It may have stopped meanwhile.
        if entry.moves.send(moved).is_err() {
            return Err(Error::State("the recording does not run".into()));
        }
        // A focus is on something of the tab that is left.
        self.close_focus(entry, None, "retargeted");
        entry.pointer = None;
        entry.recording.target = to.id.clone();
        entry.recording.tab = to.tab;
        entry
            .journal
            .add("retarget", now, now, json!({ "tab": to.tab }));
        kept::keep(&inner.files, &entry.recording);
        info!(recording = %id, target = %to.id, "recording retargeted");
        Ok(entry.recording.clone())
    }

    /// Has the recordings that follow the automation go on with the tab it is about to
    /// act on.
    pub async fn follow(&self, tab: u32) {
        if self.0.running.load(Ordering::Relaxed) == 0 {
            return;
        }
        let elsewhere: Vec<String> = {
            let recordings = self.0.recordings.lock().expect("not poisoned");
            recordings
                .values()
                .map(|entry| &entry.recording)
                .filter(|recording| recording.state == State::Recording)
                .filter(|recording| recording.follow)
                .filter(|recording| recording.tab != tab)
                .map(|recording| recording.id.clone())
                .collect()
        };
        for id in elsewhere {
            if let Err(err) = self.retarget(&id, &tab.to_string()).await {
                warn!(recording = %id, tab, "a recording does not follow automation: {err:#}");
            }
        }
    }

    /// Stops a recording and waits until its raw video is complete. The edit, where there
    /// is one, is made with `options` and goes on after. A recording that had stopped is
    /// told as it is: [`Self::edit`] makes another edit of it.
    pub async fn stop(&self, id: &str, options: Options) -> Result<Recording, Error> {
        options.check().map_err(Error::Options)?;
        let running = {
            let mut recordings = self.0.recordings.lock().expect("not poisoned");
            let Some(entry) = recordings.get_mut(id) else {
                drop(recordings);
                return self.get(id);
            };
            // While the video still runs, so that the zoom ends inside it.
            self.close_focus(entry, None, "stopped");
            if entry.running.is_some() {
                entry.stopped_with = options;
            }
            entry.running.take()
        };
        if let Some((stop, task)) = running {
            // A recording that ended by itself meanwhile takes no word to stop.
            let _ = stop.send(());
            task.await.context("the recording did not end")?;
        }
        self.get(id)
    }

    /// Makes the edit of a recording again, of the same raw video and with other options.
    /// It is made after this returns, and takes the place of the edit there is.
    pub fn edit(&self, id: &str, options: Options) -> Result<Recording, Error> {
        if !self.0.allowed {
            return Err(Error::Off);
        }
        options.check().map_err(Error::Options)?;
        let refused = |why: &str| Err(Error::State(why.into()));
        self.with(id, |recording, editing| {
            match recording.state {
                State::Recording => {
                    return refused("the recording still runs: stop it with these options");
                }
                State::Failed => return refused("the recording failed: it has no video to edit"),
                State::Finished => {}
            }
            let edit = recording.edit.as_ref();
            if edit.is_some_and(|edit| edit.state == EditState::Editing) {
                return refused("the recording is being edited: ask again once that is made");
            }
            *editing = Some(self.make(recording, options)?);
            kept::keep(&self.0.files, recording);
            info!(recording = %id, "recording edited again");
            Ok(recording.clone())
        })
        .ok_or(Error::NoRecording)?
    }

    pub fn get(&self, id: &str) -> Result<Recording, Error> {
        self.with(id, |recording, _| recording.clone())
            .ok_or(Error::NoRecording)
    }

    /// Does something to a recording, of this run or of an earlier one, and to the edit
    /// that is being made of it.
    fn with<T>(
        &self,
        id: &str,
        act: impl FnOnce(&mut Recording, &mut Option<JoinHandle<()>>) -> T,
    ) -> Option<T> {
        let mut recordings = self.0.recordings.lock().expect("not poisoned");
        if let Some(entry) = recordings.get_mut(id) {
            return Some(act(&mut entry.recording, &mut entry.editing));
        }
        drop(recordings);
        let mut earlier = self.0.earlier.lock().expect("not poisoned");
        let earlier = earlier.get_mut(id)?;
        Some(act(&mut earlier.recording, &mut earlier.editing))
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
            if let Err(err) = self.stop(&id, Options::default()).await {
                warn!(recording = %id, "a recording was not stopped: {err:#}");
            }
        }
        let files = &self.0.files;
        let give_up = |recording: &mut Recording, editing: &mut Option<JoinHandle<()>>| {
            let Some(editing) = editing.take() else {
                return;
            };
            editing.abort();
            if let Some(edit) = &mut recording.edit {
                edit.state = EditState::Failed;
                edit.failure = Some("the session ended before the edit was made".into());
            }
            kept::keep(files, recording);
        };
        let mut recordings = self.0.recordings.lock().expect("not poisoned");
        for entry in recordings.values_mut() {
            give_up(&mut entry.recording, &mut entry.editing);
        }
        drop(recordings);
        let mut earlier = self.0.earlier.lock().expect("not poisoned");
        for earlier in earlier.values_mut() {
            give_up(&mut earlier.recording, &mut earlier.editing);
        }
    }

    pub fn list(&self) -> Vec<Recording> {
        let mut list: Vec<Recording> = {
            let recordings = self.0.recordings.lock().expect("not poisoned");
            recordings
                .values()
                .map(|entry| entry.recording.clone())
                .collect()
        };
        let earlier = self.0.earlier.lock().expect("not poisoned");
        list.extend(earlier.values().map(|earlier| earlier.recording.clone()));
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    /// Whether a recording of the target runs: the session's pace is for what is recorded.
    pub fn records(&self, target: &str) -> bool {
        if self.0.running.load(Ordering::Relaxed) == 0 {
            return false;
        }
        let recordings = self.0.recordings.lock().expect("not poisoned");
        recordings
            .values()
            .map(|entry| &entry.recording)
            .filter(|recording| recording.state == State::Recording)
            .any(|recording| recording.target.eq_ignore_ascii_case(target))
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

    /// Takes in how a recording's raw video ended, and starts its edit.
    fn ended(&self, id: &str, outcome: anyhow::Result<Raw>) {
        let inner = &self.0;
        let mut recordings = inner.recordings.lock().expect("not poisoned");
        if let Some(entry) = recordings.get_mut(id) {
            // The target's window closed under it.
            self.close_focus(entry, None, "stopped");
            entry.running = None;
            let recording = &mut entry.recording;
            recording.journal_dropped = entry.journal.dropped.load(Ordering::Relaxed);
            // A recording that failed may have left no file.
            recording.bytes = std::fs::metadata(inner.files.join(&recording.file))
                .ok()
                .map(|metadata| metadata.len());
            match outcome {
                Ok(raw) => {
                    recording.state = State::Finished;
                    recording.duration_ms = Some(raw.duration_ms as u64);
                    info!(recording = %id, duration_ms = raw.duration_ms, "recording finished");
                    kept::keep_raw(&inner.files, id, &raw);
                    // Without ffmpeg recordings are left raw.
                    if inner.editor.ffmpeg.is_some() {
                        let options = std::mem::take(&mut entry.stopped_with);
                        match self.make(recording, options.clone()) {
                            Ok(editing) => entry.editing = Some(editing),
                            Err(err) => {
                                warn!(recording = %id, "recording edit failed: {err:#}");
                                recording.edit = Some(Edit {
                                    state: EditState::Failed,
                                    options,
                                    made_at_ms: None,
                                    file: None,
                                    timeline: None,
                                    failure: Some(format!("{err:#}")),
                                });
                            }
                        }
                    }
                }
                Err(err) => {
                    recording.state = State::Failed;
                    recording.failure = Some(format!("{err:#}"));
                    warn!(recording = %id, "recording failed: {err:#}");
                }
            }
            kept::keep(&inner.files, &entry.recording);
        }
        self.count(&recordings);
    }

    /// Starts making an edit of a recording whose raw video is complete. Refused where
    /// there is nothing to make it with or of: the edit there is stays then.
    fn make(&self, recording: &mut Recording, options: Options) -> Result<JoinHandle<()>, Error> {
        let inner = &self.0;
        let refused = |why: &str| Err(Error::State(why.into()));
        let Some(ffmpeg) = inner.editor.ffmpeg.clone() else {
            return refused("this session has no ffmpeg to make edits with");
        };
        let video = inner.files.join(&recording.file);
        if !video.is_file() {
            return refused(
                "the recording's raw video is gone, and an edit is made of nothing else",
            );
        }
        let raw = kept::raw_path(&inner.files, &recording.id);
        if !raw.is_file() {
            return refused("what an edit takes of the raw video was not kept with it");
        }
        recording.edit = Some(Edit {
            state: EditState::Editing,
            options: options.clone(),
            made_at_ms: None,
            file: None,
            timeline: None,
            failure: None,
        });
        let (edited, timeline) = edit::outputs(&video);
        let ask = edit::Ask {
            ffmpeg,
            journal: inner.files.join(&recording.journal),
            raw,
            work: video.with_extension("edit"),
            cache: inner.editor.cache.clone(),
            options,
            dropped: recording.journal_dropped,
            video,
            edited,
            timeline,
        };
        let recordings = self.clone();
        let id = recording.id.clone();
        Ok(tokio::spawn(async move {
            let made = finished(edit::run(ask)).await;
            recordings.edited(&id, made);
        }))
    }

    fn edited(&self, id: &str, made: anyhow::Result<()>) {
        self.with(id, |recording, editing| {
            *editing = None;
            let stem = recording.file.trim_end_matches(".mkv").to_owned();
            let Some(edit) = &mut recording.edit else {
                return;
            };
            match made {
                Ok(()) => {
                    edit.state = EditState::Finished;
                    edit.file = Some(format!("{stem}.edited.mp4"));
                    edit.timeline = Some(format!("{stem}.timeline.json"));
                    edit.made_at_ms = Some(now_ms());
                    info!(recording = %id, "recording edited");
                }
                Err(err) => {
                    edit.state = EditState::Failed;
                    edit.failure = Some(format!("{err:#}"));
                    warn!(recording = %id, "recording edit failed: {err:#}");
                }
            }
            kept::keep(&self.0.files, recording);
        });
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

/// Now, as the time of day.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// What a task made. One that panicked made a failure, so that whoever waits for what it
/// makes hears of it.
async fn finished<T: Send + 'static>(
    task: impl Future<Output = anyhow::Result<T>> + Send + 'static,
) -> anyhow::Result<T> {
    tokio::spawn(task)
        .await
        .context("what made it ended in a panic")?
}
