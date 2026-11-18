//! The edit of a recording: what is made of its raw video and its journal once it stopped.
//! The plan says what to keep and where the effects go (see [`plan`]); ffmpeg, as a process
//! of its own at low priority, makes the edited video from it. The raw video stays as it is.

pub mod plan;

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, bail};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

use self::plan::{Event, Options, Video};

/// The edited video's frame rate.
const FPS: u32 = 30;
/// An edit gets at least this long, and longer for a longer video.
const RENDER_AT_LEAST: Duration = Duration::from_secs(120);

pub struct Job {
    pub ffmpeg: PathBuf,
    /// The raw video.
    pub video: PathBuf,
    pub journal: PathBuf,
    /// Where the edited video goes.
    pub edited: PathBuf,
    /// Where the timeline goes.
    pub timeline: PathBuf,
    /// A directory of the job's own, for what ffmpeg reads besides the video.
    pub work: PathBuf,
    /// Where ffmpeg may keep what it builds once, such as its font cache.
    pub cache: PathBuf,
    pub options: Options,
    /// When the frames that showed a change came, in the raw video's time.
    pub changed_at_ms: Vec<i64>,
    pub frame: Video,
    /// Journal entries the journal's budget left out.
    pub dropped: usize,
}

/// Plans and renders the edit. Whatever it leaves in its work directory goes with it.
pub async fn run(job: Job) -> anyhow::Result<()> {
    let made = make(&job).await;
    let _ = tokio::fs::remove_dir_all(&job.work).await;
    made
}

async fn make(job: &Job) -> anyhow::Result<()> {
    let journal = tokio::fs::read_to_string(&job.journal)
        .await
        .context("failed to read the journal")?;
    // A line that does not parse is one the journal was cut short in.
    let mut events: Vec<Event> = journal
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    events.sort_by_key(|event| event.at_ms);

    let active = plan::active_spans(&job.changed_at_ms);
    let planned = plan::plan(&job.options, &events, &active, job.frame, FPS)?;

    tokio::fs::create_dir_all(&job.work).await?;
    tokio::fs::create_dir_all(&job.cache).await?;
    // ffmpeg reads the chain from a file, so its length does not meet the limit of a
    // command line.
    tokio::fs::write(job.work.join("filter.txt"), &planned.filter).await?;
    for (name, script) in [
        ("ripples.ass", &planned.ripples),
        ("captions.ass", &planned.captions),
    ] {
        if let Some(script) = script {
            tokio::fs::write(job.work.join(name), script).await?;
        }
    }
    render(job).await?;

    let timeline = plan::timeline(&planned, &events, job.dropped, job.frame);
    tokio::fs::write(&job.timeline, serde_json::to_vec_pretty(&timeline)?).await?;
    Ok(())
}

async fn render(job: &Job) -> anyhow::Result<()> {
    let mut command = Command::new(&job.ffmpeg);
    command
        .args(["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error"])
        // The video is read as the one container it is and from a file, so that nothing in
        // it can name something else to read.
        .args(["-protocol_whitelist", "file", "-f", "matroska"])
        .arg("-i")
        .arg(&job.video)
        .args(["-xerror", "-y", "-an", "-/vf", "filter.txt"])
        .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"])
        .args(["-pix_fmt", "yuv420p", "-fps_mode", "passthrough"])
        .args(["-movflags", "+faststart", "-f", "mp4"])
        .arg(&job.edited)
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
            // The edit yields to the session it runs beside.
            libc::setpriority(libc::PRIO_PROCESS, 0, 10);
            Ok(())
        });
    }
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
