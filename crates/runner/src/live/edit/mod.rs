//! The edit of a recording: what is made of its raw video and its journal once it stopped.
//! The plan says what to keep and where the effects go (see [`plan`]); ffmpeg, as a process
//! of its own at low priority, makes the edited video from it. The raw video stays as it is,
//! and with it what an edit takes besides, so that the edit is made again with other
//! options whenever it is asked for: it takes the place of the one before.

pub mod plan;

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};
use tracing::warn;

use self::plan::{Event, Options, Segment, Video};

/// An edit gets at least this long, and longer for a longer video.
const RENDER_AT_LEAST: Duration = Duration::from_secs(120);

/// What a raw video turned out to be, as an edit has to know it. It is kept next to the
/// video, as the journal is: an edit is made of the three of them.
#[derive(Debug, Serialize, Deserialize)]
pub struct Raw {
    pub duration_ms: i64,
    /// Its frames that showed a change: when each came, in its own time, and how many
    /// pixels of the picture changed in it.
    pub changed: Vec<(i64, u64)>,
    /// The sizes its picture has, each from when it has it.
    pub segments: Vec<Segment>,
}

impl Raw {
    /// When something happened in the picture: the times of the frames in which at least
    /// `threshold` of it changed, see [`Options::motion_threshold`].
    fn changed_at_ms(&self, threshold: f64) -> Vec<i64> {
        let mut segments = self.segments.iter().peekable();
        let mut whole = 0.0;
        let mut happened = Vec::new();
        for &(at_ms, changed) in &self.changed {
            while let Some(segment) = segments.next_if(|segment| segment.at_ms <= at_ms) {
                whole = f64::from(segment.width) * f64::from(segment.height);
            }
            if changed as f64 >= whole * threshold {
                happened.push(at_ms);
            }
        }
        happened
    }
}

/// An edit to make.
pub struct Ask {
    pub ffmpeg: PathBuf,
    /// The raw video.
    pub video: PathBuf,
    pub journal: PathBuf,
    /// What the raw video turned out to be, see [`Raw`].
    pub raw: PathBuf,
    /// Where the edited video goes.
    pub edited: PathBuf,
    /// Where the timeline goes.
    pub timeline: PathBuf,
    /// A directory of the job's own, for what ffmpeg reads besides the video.
    pub work: PathBuf,
    /// Where ffmpeg may keep what it builds once, such as its font cache.
    pub cache: PathBuf,
    pub options: Options,
    /// Journal entries the journal's budget left out.
    pub dropped: usize,
}

struct Job {
    ffmpeg: PathBuf,
    video: PathBuf,
    journal: PathBuf,
    /// Where the edited video and the timeline are made, in the job's directory.
    edited: PathBuf,
    timeline: PathBuf,
    work: PathBuf,
    cache: PathBuf,
    options: Options,
    /// When the frames that showed a change came, in the raw video's time.
    changed_at_ms: Vec<i64>,
    /// The frame every picture of the raw video fits in.
    frame: Video,
    /// The sizes the raw video's picture has.
    segments: Vec<Segment>,
    dropped: usize,
}

/// Plans and renders the edit, which takes the place of the one made before only once it
/// is whole. An edit that fails leaves none: the one before was of other options than the
/// recording now tells. Whatever it leaves in its work directory goes with it.
pub async fn run(ask: Ask) -> anyhow::Result<()> {
    let made = async {
        let raw = tokio::fs::read(&ask.raw)
            .await
            .context("failed to read what was kept of the raw video")?;
        let raw: Raw = serde_json::from_slice(&raw).context("what was kept of the raw video")?;
        let job = Job {
            ffmpeg: ask.ffmpeg.clone(),
            video: ask.video.clone(),
            journal: ask.journal.clone(),
            edited: ask.work.join("edited.mp4"),
            timeline: ask.work.join("timeline.json"),
            work: ask.work.clone(),
            cache: ask.cache.clone(),
            changed_at_ms: raw.changed_at_ms(ask.options.motion_threshold),
            options: ask.options.clone(),
            frame: Video::fitting(raw.duration_ms, &raw.segments),
            segments: raw.segments,
            dropped: ask.dropped,
        };
        make(&job).await?;
        tokio::fs::rename(&job.edited, &ask.edited).await?;
        tokio::fs::rename(&job.timeline, &ask.timeline).await?;
        anyhow::Ok(())
    }
    .await;
    if made.is_err() {
        for left in [&ask.edited, &ask.timeline] {
            match tokio::fs::remove_file(left).await {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => warn!(file = ?left, %err, "the edit made before is left behind"),
            }
        }
    }
    match tokio::fs::remove_dir_all(&ask.work).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => warn!(work = ?ask.work, %err, "what an edit worked in is left behind"),
    }
    made
}

async fn make(job: &Job) -> anyhow::Result<()> {
    let journal = tokio::fs::read_to_string(&job.journal)
        .await
        .context("failed to read the journal")?;
    let mut events: Vec<Event> = Vec::new();
    for (line, said) in journal.lines().enumerate() {
        match serde_json::from_str(said) {
            Ok(event) => events.push(event),
            // The journal was cut short in it, where it is the last one.
            Err(err) => {
                warn!(journal = ?job.journal, line = line + 1, %err, "a journal entry is not read")
            }
        }
    }
    events.sort_by_key(|event| event.at_ms);

    let active = plan::active_spans(&job.changed_at_ms);
    // The plan is of the frame; the journal is of the picture, which may be smaller.
    let placed = plan::placed(&events, &job.segments, job.frame);
    let planned = plan::plan(&job.options, &placed, &active, job.frame, job.options.fps)?;

    tokio::fs::create_dir_all(&job.work).await?;
    tokio::fs::create_dir_all(&job.cache).await?;
    // ffmpeg reads the chain from a file, so its length does not meet the limit of a
    // command line.
    tokio::fs::write(job.work.join("filter.txt"), &planned.filter).await?;
    tokio::fs::write(job.work.join("sound.txt"), &planned.sound).await?;
    for (name, script) in [
        ("ripples.ass", &planned.ripples),
        ("captions.ass", &planned.captions),
    ] {
        if let Some(script) = script {
            tokio::fs::write(job.work.join(name), script).await?;
        }
    }
    if job.segments.len() > 1 {
        cut(job).await?;
        let graph = graph(&job.segments, job.frame, &planned);
        tokio::fs::write(job.work.join("graph.txt"), graph).await?;
    }
    render(job).await?;

    let timeline = plan::timeline(&planned, &events, job.dropped, job.frame, &job.segments);
    tokio::fs::write(&job.timeline, serde_json::to_vec_pretty(&timeline)?).await?;
    Ok(())
}

/// The file a segment of the raw video is cut into, in the job's directory.
fn piece(index: usize) -> String {
    format!("segment-{index}.mkv")
}

/// Cuts a raw video whose picture changes size into its segments, each a file of its own,
/// without decoding it. Filters take one size, and ffmpeg settles on the size of what it
/// gives them from whatever it has decoded by the time every input has a frame: an input
/// that reads on into the next segment gets that one's size on some runs, and its picture
/// is then cut and placed as one of that size. A segment begins with a keyframe, so it is
/// a video by itself.
async fn cut(job: &Job) -> anyhow::Result<()> {
    let mut command = ffmpeg(job);
    for (index, segment) in job.segments.iter().enumerate() {
        command.args(["-an", "-ss", &format!("{}ms", segment.at_ms)]);
        // What is copied ends where it is read, which what is decoded does not.
        if let Some(next) = job.segments.get(index + 1) {
            command.args(["-t", &format!("{}ms", next.at_ms - segment.at_ms)]);
        }
        command.args(READ).arg("-i").arg(&job.video);
    }
    for index in 0..job.segments.len() {
        command.args(["-map", &format!("{index}:v:0"), "-c", "copy"]);
        command.args(["-f", "matroska"]).arg(piece(index));
    }
    finish(job, command).await
}

/// The filters of a raw video whose picture changes size: every segment is put where it
/// goes in the frame and back at its time, and the plan's chain takes them as one video.
fn graph(segments: &[Segment], frame: Video, planned: &plan::Plan) -> String {
    let seconds = |ms: i64| ms as f64 / 1000.0;
    let mut graph = String::new();
    for (index, segment) in segments.iter().enumerate() {
        let (x, y) = segment.placed(frame);
        graph += &format!(
            "[{index}:v]setpts=PTS+{at:.3}/TB,pad={width}:{height}:{x}:{y},setsar=1[s{index}];",
            at = seconds(segment.at_ms),
            width = frame.width,
            height = frame.height,
        );
    }
    for index in 0..segments.len() {
        graph += &format!("[s{index}]");
    }
    graph += &format!("interleave=n={},{}[v]", segments.len(), planned.filter);
    graph
}

/// A video is read as the one container it is and from a file, so that nothing in it can
/// name something else to read.
const READ: [&str; 4] = ["-protocol_whitelist", "file", "-f", "matroska"];

/// ffmpeg as the edit runs it: in the job's directory, with nothing of the runner's
/// environment, and yielding to the session it runs beside.
fn ffmpeg(job: &Job) -> Command {
    let mut command = Command::new(&job.ffmpeg);
    command
        .args(["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error"])
        .args(["-xerror", "-y"])
        .current_dir(&job.work)
        .env_clear()
        .env("HOME", &job.work)
        .env("TMPDIR", &job.work)
        .env("XDG_CACHE_HOME", &job.cache)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // Whoever gives up on the edit takes ffmpeg down with it.
        .kill_on_drop(true);
    // Safety: `setpriority` is async-signal-safe, and nothing else runs between fork and
    // exec.
    unsafe {
        command.pre_exec(|| {
            libc::setpriority(libc::PRIO_PROCESS, 0, 10);
            Ok(())
        });
    }
    command
}

async fn render(job: &Job) -> anyhow::Result<()> {
    let mut command = ffmpeg(job);
    if job.segments.len() > 1 {
        for index in 0..job.segments.len() {
            command.args(READ).arg("-i").arg(piece(index));
        }
        // The sound is read whole, and filtered by itself: as a part of the graph its
        // times come out of order.
        let sound = format!("{}:a", job.segments.len());
        command.arg("-vn").args(READ).arg("-i").arg(&job.video);
        command.args([
            "-/filter_complex",
            "graph.txt",
            "-map",
            "[v]",
            "-map",
            &sound,
        ]);
        command.args(["-/af", "sound.txt"]);
    } else {
        command.args(READ).arg("-i").arg(&job.video);
        command.args(["-/vf", "filter.txt", "-/af", "sound.txt"]);
    }
    command
        .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"])
        .args(["-c:a", "aac", "-b:a", "128k"])
        .args(["-pix_fmt", "yuv420p", "-fps_mode", "passthrough"])
        .args(["-movflags", "+faststart", "-f", "mp4"])
        .arg(&job.edited);
    finish(job, command).await
}

/// Runs ffmpeg to its end, which it gets the longer for the longer the video is. What it
/// said last tells why it failed.
async fn finish(job: &Job, mut command: Command) -> anyhow::Result<()> {
    let mut ffmpeg = command.spawn().context("failed to start ffmpeg")?;
    let mut errors = ffmpeg.stderr.take().context("ffmpeg has no error output")?;

    let allowed = RENDER_AT_LEAST.max(Duration::from_millis(job.frame.duration_ms as u64 * 10));
    let finished = async {
        let mut said = String::new();
        errors.read_to_string(&mut said).await?;
        anyhow::Ok((ffmpeg.wait().await?, said))
    };
    let (status, said) = timeout(allowed, finished)
        .await
        .with_context(|| format!("the edit took longer than {allowed:?}"))??;
    if !status.success() {
        let said = said.trim();
        let tail = &said[said.len().saturating_sub(1000)..];
        bail!("ffmpeg failed ({status}): {tail}");
    }
    Ok(())
}

/// Where the edit's files go, next to the raw video `recordings/<id>.mkv`.
pub fn outputs(video: &Path) -> (PathBuf, PathBuf) {
    (
        video.with_extension("edited.mp4"),
        video.with_extension("timeline.json"),
    )
}
