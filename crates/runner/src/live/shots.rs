//! Screenshots of targets, kept in the session's files next to its recordings.

use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use aperture_compositor::Frame;
use serde::{Deserialize, Serialize};

use super::http::{encode_png, shrunk};

const DIRECTORY: &str = "screenshots";

/// How wide the small picture is that stands for a screenshot or a recording in a list.
pub const PREVIEW_WIDTH: u32 = 480;

const PREVIEW: &str = ".preview.png";

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

/// The screenshots there are, newest first, as their files tell.
pub fn list(files: &Path) -> Vec<Screenshot> {
    let Ok(entries) = std::fs::read_dir(files.join(DIRECTORY)) else {
        return Vec::new();
    };
    let mut screenshots: Vec<Screenshot> = entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(KEPT))
        .filter_map(|entry| serde_json::from_slice(&std::fs::read(entry.path()).ok()?).ok())
        .collect();
    screenshots.sort_by(|a, b| b.taken_at_ms.cmp(&a.taken_at_ms));
    screenshots
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}
