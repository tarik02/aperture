//! The session's files as the browser makes and takes them: what it downloads, in
//! `downloads` of the session's files, and what is put there for it to take, in `uploads`.

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::json;
use tokio::sync::watch;

use crate::cdp;

pub const DOWNLOADS: &str = "downloads";
pub const UPLOADS: &str = "uploads";

/// How many downloads are told of; the oldest go first.
const KEPT: usize = 100;
/// The least time between two tellings of downloads that only got further.
const TOLD_APART: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Progress {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Download {
    pub id: String,
    /// The file's name in `downloads`: the one the page suggested until the browser has
    /// saved it, which may be under another.
    pub name: String,
    pub url: String,
    pub received: u64,
    /// None while the page does not say.
    pub total: Option<u64>,
    pub state: Progress,
}

/// Where a file named `name` is in a directory of the session's files, if it is a name: one
/// that is no path and that no listing hides.
pub fn named(directory: &Path, name: &str) -> Option<PathBuf> {
    let plain = Path::new(name).file_name().and_then(|plain| plain.to_str()) == Some(name);
    (plain && !name.starts_with('.') && name.len() <= 255).then(|| directory.join(name))
}

/// Has the browser save what it downloads into the session's files without asking, and
/// follows what it downloads.
pub async fn follow_downloads(
    browser: cdp::Client,
    files: &Path,
    allowed: bool,
) -> anyhow::Result<watch::Receiver<Vec<Download>>> {
    let directory = files.join(DOWNLOADS);
    tokio::fs::create_dir_all(&directory).await?;
    let mut events = browser.events();
    let behavior = if allowed {
        json!({ "behavior": "allow", "downloadPath": directory, "eventsEnabled": true })
    } else {
        json!({ "behavior": "deny" })
    };
    browser
        .call("Browser.setDownloadBehavior", behavior)
        .await?;
    let (told, downloads) = watch::channel(Vec::new());
    tokio::spawn(async move {
        let mut list: Vec<Download> = Vec::new();
        let mut last = Instant::now();
        while let Some(event) = events.next().await {
            // The list stays empty, and is still someone's to wait on.
            if !allowed {
                continue;
            }
            let id = event.params["guid"].as_str().unwrap_or_default();
            match event.method.as_str() {
                "Browser.downloadWillBegin" => {
                    if list.len() == KEPT {
                        list.remove(0);
                    }
                    let text = |field: &str| event.params[field].as_str().unwrap_or_default();
                    list.push(Download {
                        id: id.to_owned(),
                        name: text("suggestedFilename").to_owned(),
                        url: text("url").to_owned(),
                        received: 0,
                        total: None,
                        state: Progress::Running,
                    });
                }
                "Browser.downloadProgress" => {
                    let Some(download) = list.iter_mut().find(|download| download.id == id) else {
                        continue;
                    };
                    let bytes = |field: &str| event.params[field].as_f64().unwrap_or(0.0) as u64;
                    download.received = bytes("receivedBytes");
                    download.total = Some(bytes("totalBytes")).filter(|total| *total > 0);
                    download.state = match event.params["state"].as_str() {
                        Some("completed") => Progress::Done,
                        Some("canceled") => Progress::Failed,
                        _ => Progress::Running,
                    };
                    let saved = event.params["filePath"].as_str().map(Path::new);
                    if let Some(name) = saved.and_then(|saved| saved.file_name()?.to_str()) {
                        name.clone_into(&mut download.name);
                    }
                    if download.state == Progress::Running && last.elapsed() < TOLD_APART {
                        continue;
                    }
                }
                _ => continue,
            }
            last = Instant::now();
            told.send_replace(list.clone());
        }
    });
    Ok(downloads)
}
