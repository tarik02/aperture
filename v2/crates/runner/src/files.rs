//! The session's files as the browser makes and takes them: what it downloads, in
//! `downloads` of the session's files, and what is put there for it to take, in `uploads`,
//! which a page that asks for files is answered with.

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::Context;
use serde::Serialize;
use serde_json::json;
use tokio::sync::{broadcast, watch};
use tracing::debug;

use crate::{cdp, targets::Target};

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
) -> anyhow::Result<watch::Receiver<Vec<Download>>> {
    let directory = files.join(DOWNLOADS);
    tokio::fs::create_dir_all(&directory).await?;
    let mut events = browser.events();
    browser
        .call(
            "Browser.setDownloadBehavior",
            json!({ "behavior": "allow", "downloadPath": directory, "eventsEnabled": true }),
        )
        .await?;
    let (told, downloads) = watch::channel(Vec::new());
    tokio::spawn(async move {
        let mut list: Vec<Download> = Vec::new();
        let mut last = Instant::now();
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            };
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

/// A page asked for files, as it does when a file input is clicked. The browser shows no
/// dialog of its own: whoever uses the session answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Request {
    pub id: u64,
    /// The page's target.
    pub target: String,
    /// The page takes more than one file.
    pub multiple: bool,
}

/// The requests of pages for files that nobody answered yet.
#[derive(Clone)]
pub struct Requests {
    browser: cdp::Client,
    open: watch::Sender<Vec<Open>>,
}

#[derive(Clone)]
struct Open {
    request: Request,
    /// The DevTools session the page is attached as, and the input's node in it.
    session: String,
    node: i64,
}

impl Requests {
    /// Has the pages of `targets` ask here for files instead of opening the browser's
    /// dialog, which nobody would see, and follows what they ask for.
    pub fn follow(browser: cdp::Client, mut targets: watch::Receiver<Vec<Target>>) -> Self {
        let requests = Self {
            browser: browser.clone(),
            open: watch::Sender::new(Vec::new()),
        };
        let open = requests.open.clone();
        // The pages there are by now are looked at first.
        targets.mark_changed();
        tokio::spawn(async move {
            // Before any page is attached, so no event of one is missed.
            let mut events = browser.events();
            // The targets' pages by the session each is attached as.
            let mut attached: Vec<(String, String)> = Vec::new();
            let mut next = 0;
            loop {
                tokio::select! {
                    changed = targets.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                    event = events.recv() => {
                        let event = match event {
                            Ok(event) => event,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => return,
                        };
                        if event.method != "Page.fileChooserOpened" {
                            continue;
                        }
                        let target = attached
                            .iter()
                            .find(|(_, session)| Some(session) == event.session.as_ref());
                        let node = event.params["backendNodeId"].as_i64();
                        if let (Some((target, session)), Some(node)) = (target, node) {
                            next += 1;
                            let asked = Open {
                                request: Request {
                                    id: next,
                                    target: target.clone(),
                                    multiple: event.params["mode"] == "selectMultiple",
                                },
                                session: session.clone(),
                                node,
                            };
                            open.send_modify(|open| {
                                // A page asks for one thing at a time.
                                open.retain(|before| before.request.target != *target);
                                open.push(asked);
                            });
                        }
                        continue;
                    }
                }
                let pages: Vec<String> = targets
                    .borrow_and_update()
                    .iter()
                    .map(|target| target.id.clone())
                    .collect();
                attached.retain(|(target, _)| pages.contains(target));
                open.send_if_modified(|open| {
                    let before = open.len();
                    open.retain(|asked| pages.contains(&asked.request.target));
                    open.len() != before
                });
                for page in pages {
                    if attached.iter().any(|(target, _)| *target == page) {
                        continue;
                    }
                    match intercept(&browser, &page).await {
                        Ok(session) => attached.push((page, session)),
                        Err(err) => {
                            debug!(page, "a page's file dialogs stay the browser's: {err:#}")
                        }
                    }
                }
            }
        });
        requests
    }

    pub fn open(&self) -> watch::Receiver<Vec<Request>> {
        let mut open = self.open.subscribe();
        let (told, requests) = watch::channel(Vec::new());
        tokio::spawn(async move {
            loop {
                let now: Vec<Request> = open
                    .borrow_and_update()
                    .iter()
                    .map(|open| open.request.clone())
                    .collect();
                told.send_replace(now);
                if open.changed().await.is_err() || told.is_closed() {
                    return;
                }
            }
        });
        requests
    }

    /// Answers a request with files, or with none, which leaves the page without.
    pub async fn answer(&self, id: u64, files: Vec<PathBuf>) -> Result<(), cdp::Error> {
        let mut asked = None;
        self.open.send_if_modified(|open| {
            let at = open.iter().position(|open| open.request.id == id);
            asked = at.map(|at| open.remove(at));
            asked.is_some()
        });
        let Some(asked) = asked.filter(|_| !files.is_empty()) else {
            return Ok(());
        };
        self.browser
            .call_in(
                Some(&asked.session),
                "DOM.setFileInputFiles",
                json!({ "files": files, "backendNodeId": asked.node }),
            )
            .await?;
        Ok(())
    }
}

/// Attaches the page and has it ask for files here; gives the session it is attached as.
async fn intercept(browser: &cdp::Client, page: &str) -> anyhow::Result<String> {
    let attached = browser
        .call(
            "Target.attachToTarget",
            json!({ "targetId": page, "flatten": true }),
        )
        .await?;
    let session = attached["sessionId"]
        .as_str()
        .context("the browser attached no session")?;
    browser
        .call_in(Some(session), "Page.enable", json!({}))
        .await?;
    browser
        .call_in(
            Some(session),
            "Page.setInterceptFileChooserDialog",
            json!({ "enabled": true }),
        )
        .await?;
    Ok(session.to_owned())
}
