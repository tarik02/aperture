//! Screenshots of targets, kept in the session's files next to its recordings.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use aperture_compositor::{Frame, Handle};
use serde::{Deserialize, Serialize};
use tracing::warn;

use super::http::{encode_png, shrunk};

const DIRECTORY: &str = "screenshots";

/// How wide the small picture is that stands for a screenshot or a recording in a list.
pub const PREVIEW_WIDTH: u32 = 480;

const PREVIEW: &str = ".preview.png";

/// How wide the small picture of a tab is, for a list of the tabs.
const TAB_WIDTH: u32 = 360;
/// How long a tab's small picture stands for the tab before another is made.
const TAB_FRESH_FOR: Duration = Duration::from_secs(2);

/// A tab's small picture.
pub struct TabPreview {
    pub png: Vec<u8>,
    /// What tells this picture from any other, as an entity tag.
    pub tag: String,
    made: Instant,
}

/// A tab's small picture as it was last made. Whoever asks for it while it is made waits
/// for that one.
type Made = Arc<tokio::sync::Mutex<Option<Arc<TabPreview>>>>;

/// The small pictures of the tabs, each made no more than once in a while.
#[derive(Default)]
pub struct Previews {
    /// By target.
    made: Mutex<HashMap<String, Made>>,
}

impl Previews {
    /// The target's small picture: the one there is while it is fresh, a new one after.
    /// `known` are the targets there are, whose pictures are kept.
    pub async fn of(
        &self,
        compositor: &Handle,
        target: &crate::targets::Target,
        known: &[String],
    ) -> Result<Arc<TabPreview>, aperture_compositor::Error> {
        let slot = {
            let mut made = self.made.lock().expect("not poisoned");
            made.retain(|id, _| known.contains(id));
            made.entry(target.id.clone()).or_default().clone()
        };
        let mut slot = slot.lock().await;
        if let Some(fresh) = slot
            .as_ref()
            .filter(|preview| preview.made.elapsed() < TAB_FRESH_FOR)
        {
            return Ok(fresh.clone());
        }
        let frame = compositor.screenshot(target.window).await?;
        let encoded = tokio::task::spawn_blocking(move || {
            let (width, height, rgba) = if frame.width > TAB_WIDTH {
                shrunk(&frame, TAB_WIDTH)
            } else {
                (frame.width, frame.height, frame.rgba)
            };
            encode_png(width, height, rgba)
        });
        let png = encoded
            .await
            .map_err(|err| aperture_compositor::Error::Render(err.to_string()))?
            .map_err(|err| aperture_compositor::Error::Render(err.to_string()))?;
        // The same picture as before keeps its tag, so whoever has it is told so.
        let tag = {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            png.hash(&mut hasher);
            format!("\"{:016x}\"", hasher.finish())
        };
        let preview = Arc::new(TabPreview {
            png,
            tag,
            made: Instant::now(),
        });
        *slot = Some(preview.clone());
        Ok(preview)
    }
}

/// What is told of a screenshot, next to its picture.
const KEPT: &str = ".screenshot.json";

/// A screenshot as it is told, and as it is kept next to its picture.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Screenshot {
    pub id: String,
    /// The page's title and address as it was taken.
    pub title: String,
    pub url: String,
    /// The picture's file, relative to the session's files.
    pub file: String,
    /// The same picture, small.
    pub preview: String,
    /// The picture's size in pixels.
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub taken_at_ms: u64,
}

/// The frame as a small PNG picture.
pub fn preview(frame: &Frame) -> Result<Vec<u8>, png::EncodingError> {
    let (width, height, rgba) = if frame.width > PREVIEW_WIDTH {
        shrunk(frame, PREVIEW_WIDTH)
    } else {
        (frame.width, frame.height, frame.rgba.clone())
    };
    encode_png(width, height, rgba)
}

/// Keeps the frame as a screenshot of a page in the session's files.
pub fn keep(files: &Path, frame: Frame, title: String, url: String) -> anyhow::Result<Screenshot> {
    let id = uuid::Uuid::now_v7().simple().to_string();
    let directory = files.join(DIRECTORY);
    std::fs::create_dir_all(&directory)?;
    let small = preview(&frame)?;
    let (width, height) = (frame.width, frame.height);
    let picture = encode_png(width, height, frame.rgba)?;
    std::fs::write(directory.join(format!("{id}{PREVIEW}")), small)?;
    std::fs::write(directory.join(format!("{id}.png")), &picture)?;
    let screenshot = Screenshot {
        file: format!("{DIRECTORY}/{id}.png"),
        preview: format!("{DIRECTORY}/{id}{PREVIEW}"),
        title,
        url,
        width,
        height,
        bytes: picture.len() as u64,
        taken_at_ms: millis(SystemTime::now()),
        id,
    };
    // Written last: a screenshot is one once this tells of it.
    std::fs::write(
        directory.join(format!("{}{KEPT}", screenshot.id)),
        serde_json::to_vec_pretty(&screenshot)?,
    )?;
    Ok(screenshot)
}

/// The screenshots there are, newest first, as their files tell. One that cannot be read
/// is said and left out.
pub fn list(files: &Path) -> std::io::Result<Vec<Screenshot>> {
    let entries = match std::fs::read_dir(files.join(DIRECTORY)) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut screenshots = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        if !name.to_string_lossy().ends_with(KEPT) {
            continue;
        }
        let read = std::fs::read(entry.path())
            .map_err(anyhow::Error::from)
            .and_then(|kept| Ok(serde_json::from_slice::<Screenshot>(&kept)?));
        match read {
            Ok(screenshot) => screenshots.push(screenshot),
            Err(err) => warn!(file = ?name, "a kept screenshot is not read: {err:#}"),
        }
    }
    screenshots.sort_by_key(|screenshot| std::cmp::Reverse(screenshot.taken_at_ms));
    Ok(screenshots)
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}
