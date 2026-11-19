//! What pages ask of whoever uses the session, where the browser would show something of
//! its own that nobody sees: files, when a file input is clicked, and a menu, at a right
//! click. The runner keeps a DevTools session of its own with each page to hear of them,
//! and to take a page elsewhere.

use std::{path::PathBuf, sync::Arc};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};
use tracing::warn;

use crate::{cdp, targets::Target};

/// A page asked for files. The browser shows no dialog of its own: whoever uses the
/// session answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Request {
    pub id: u64,
    /// The page's target.
    pub target: String,
    /// The page takes more than one file.
    pub multiple: bool,
}

/// A page was asked for its menu and showed none of its own: what the menu is of.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Menu {
    #[serde(skip)]
    pub target: String,
    /// The link there.
    pub link: Option<String>,
    /// The picture there.
    pub image: Option<String>,
    /// The text that is selected.
    pub text: Option<String>,
    /// There is a field to write into.
    pub editable: bool,
}

/// Where to take a page along its history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Along {
    Back,
    Forward,
    Reload,
}

/// What a new tab shows when it is asked for with no page to open.
const NEW_TAB: &str = "chrome://newtab/";
/// The name pages call the runner by, and the name of the world of a page the runner's
/// own script runs in, apart from the page's.
const CALL: &str = "apertureMenu";
const WORLD: &str = "aperture";

/// Tells of a right click the page made nothing of: pages with a menu of their own keep
/// theirs. What was under the pointer is looked at when the click comes, and whether the
/// page took it once the page has had it.
const SCRIPT: &str = r#"(() => {
  if (globalThis.apertureListens) return;
  globalThis.apertureListens = true;
  addEventListener("contextmenu", (event) => {
    const under = event.composedPath().filter((node) => node instanceof Element);
    const link = under.find((node) => node.matches("a[href], area[href]"));
    const image = under.find((node) => node.matches("img"));
    const editable = under.some((node) => node.isContentEditable || node.matches("input, textarea"));
    const text = String(getSelection()).slice(0, 4096);
    setTimeout(() => {
      if (event.defaultPrevented) return;
      apertureMenu(JSON.stringify({ link: link?.href, image: image?.currentSrc || image?.src, text: text || undefined, editable }));
    });
  }, true);
})()"#;

#[derive(Clone)]
pub struct Pages {
    browser: cdp::Client,
    open: watch::Sender<Vec<Open>>,
    menus: broadcast::Sender<Menu>,
    /// The targets' pages by the DevTools session each is attached as.
    attached: Arc<watch::Sender<Vec<(String, String)>>>,
}

#[derive(Clone)]
struct Open {
    request: Request,
    /// The DevTools session the page is attached as, and the input's node in it.
    session: String,
    node: i64,
}

impl Pages {
    /// Attaches the pages of `targets` as they come, and follows what they ask for.
    pub fn follow(
        browser: cdp::Client,
        mut targets: watch::Receiver<Vec<Target>>,
        uploads: bool,
    ) -> Self {
        let pages = Self {
            browser: browser.clone(),
            open: watch::Sender::new(Vec::new()),
            menus: broadcast::Sender::new(16),
            attached: Arc::new(watch::Sender::new(Vec::new())),
        };
        let mut follower = Follower {
            // Before any page is attached, so no event of one is missed.
            events: browser.events(),
            pages: pages.clone(),
            uploads,
            asked: 0,
            frames: Vec::new(),
        };
        // The pages there are by now are looked at first.
        targets.mark_changed();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = targets.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        let pages = targets
                            .borrow_and_update()
                            .iter()
                            .map(|target| target.id.clone())
                            .collect();
                        follower.keep(pages).await;
                    }
                    event = follower.events.next() => match event {
                        Some(event) => follower.hear(event).await,
                        None => return,
                    },
                }
            }
        });
        pages
    }

    /// The requests of pages for files that nobody answered yet.
    pub fn requests(&self) -> watch::Receiver<Vec<Request>> {
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

    /// The menus pages are asked for, as they are.
    pub fn menus(&self) -> broadcast::Receiver<Menu> {
        self.menus.subscribe()
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

    async fn call(&self, target: &str, method: &str, params: Value) -> anyhow::Result<Value> {
        let session = self
            .attached
            .borrow()
            .iter()
            .find(|(attached, _)| attached == target)
            .map(|(_, session)| session.clone())
            .context("the page is not attached")?;
        Ok(self.browser.call_in(Some(&session), method, params).await?)
    }

    /// Opens a page on the web: in the target's tab, or in a new one.
    pub async fn open(&self, target: &str, url: &str, new_tab: bool) -> anyhow::Result<()> {
        if new_tab && url.is_empty() {
            self.browser
                .call("Target.createTarget", json!({ "url": NEW_TAB }))
                .await?;
            return Ok(());
        }
        let web = url::Url::parse(url).is_ok_and(|url| matches!(url.scheme(), "http" | "https"));
        if !web {
            bail!("not a page on the web");
        }
        if new_tab {
            self.browser
                .call("Target.createTarget", json!({ "url": url }))
                .await?;
        } else {
            self.call(target, "Page.navigate", json!({ "url": url }))
                .await?;
        }
        Ok(())
    }

    /// Closes the target's tab.
    pub async fn close(&self, target: &str) -> anyhow::Result<()> {
        self.browser
            .call("Target.closeTarget", json!({ "targetId": target }))
            .await?;
        Ok(())
    }

    /// Takes the target's page along its history.
    pub async fn go(&self, target: &str, along: Along) -> anyhow::Result<()> {
        let step = match along {
            Along::Reload => {
                self.call(target, "Page.reload", json!({})).await?;
                return Ok(());
            }
            Along::Back => -1,
            Along::Forward => 1,
        };
        let history = self
            .call(target, "Page.getNavigationHistory", json!({}))
            .await?;
        let entry = history["currentIndex"]
            .as_i64()
            .and_then(|at| usize::try_from(at + step).ok())
            .and_then(|at| history["entries"].get(at)?["id"].as_i64());
        // Nowhere to go that way is fine.
        if let Some(entry) = entry {
            self.call(
                target,
                "Page.navigateToHistoryEntry",
                json!({ "entryId": entry }),
            )
            .await?;
        }
        Ok(())
    }

    /// A picture the target's page shows, as the page has it: its bytes, and what kind
    /// of picture they are.
    pub async fn picture(
        &self,
        target: &str,
        url: &str,
    ) -> anyhow::Result<(&'static str, Vec<u8>)> {
        use base64::Engine;
        let frames = self.call(target, "Page.getFrameTree", json!({})).await?;
        let frame = frames["frameTree"]["frame"]["id"]
            .as_str()
            .context("the page has no frame")?;
        let had = self
            .call(
                target,
                "Page.getResourceContent",
                json!({ "frameId": frame, "url": url }),
            )
            .await?;
        let content = had["content"].as_str().unwrap_or_default();
        let bytes = if had["base64Encoded"] == true {
            base64::engine::general_purpose::STANDARD.decode(content)?
        } else {
            content.as_bytes().to_vec()
        };
        let kind = match bytes.as_slice() {
            [0x89, b'P', b'N', b'G', ..] => "image/png",
            [0xff, 0xd8, ..] => "image/jpeg",
            [b'G', b'I', b'F', b'8', ..] => "image/gif",
            [
                b'R',
                b'I',
                b'F',
                b'F',
                _,
                _,
                _,
                _,
                b'W',
                b'E',
                b'B',
                b'P',
                ..,
            ] => "image/webp",
            _ if content.contains("<svg") => "image/svg+xml",
            _ => bail!("not a picture"),
        };
        Ok((kind, bytes))
    }
}

/// What follows the pages for [`Pages`].
struct Follower {
    pages: Pages,
    events: cdp::Events,
    /// Whether pages get the files they ask for.
    uploads: bool,
    /// How many requests for files there were, which numbers them.
    asked: u64,
    /// The frames of the targets' pages that are pages of their own to the browser, each
    /// by the target it is in and the DevTools session it is attached as.
    frames: Vec<(String, String)>,
}

impl Follower {
    /// Attaches the pages that are new, and forgets what was of those that are gone.
    async fn keep(&mut self, pages: Vec<String>) {
        let Pages {
            browser,
            open,
            attached,
            ..
        } = &self.pages;
        attached.send_modify(|attached| {
            attached.retain(|(target, _)| pages.contains(target));
        });
        self.frames.retain(|(target, _)| pages.contains(target));
        open.send_if_modified(|open| {
            let before = open.len();
            open.retain(|asked| pages.contains(&asked.request.target));
            open.len() != before
        });
        for page in pages {
            if attached.borrow().iter().any(|(target, _)| *target == page) {
                continue;
            }
            match attach(browser, &page).await {
                Ok(session) => attached.send_modify(|attached| attached.push((page, session))),
                Err(err) => warn!(page, "a page asks the browser, not the session: {err:#}"),
            }
        }
    }

    /// Takes an event of a page that is followed, or of a frame in one.
    async fn hear(&mut self, event: cdp::Event) {
        let from = self
            .pages
            .attached
            .borrow()
            .iter()
            .chain(&self.frames)
            .find(|(_, session)| Some(session) == event.session.as_ref())
            .cloned();
        let Some((target, session)) = from else {
            return;
        };
        match event.method.as_str() {
            "Target.attachedToTarget" => {
                let frame = event.params["sessionId"].as_str();
                let Some(frame) = frame.filter(|_| event.params["targetInfo"]["type"] == "iframe")
                else {
                    return;
                };
                match attach_frame(&self.pages.browser, frame).await {
                    Ok(()) => self.frames.push((target, frame.to_owned())),
                    Err(err) => warn!(
                        page = target,
                        "a frame asks the browser, not the session: {err:#}"
                    ),
                }
            }
            "Target.detachedFromTarget" => {
                let gone = event.params["sessionId"].as_str();
                self.frames
                    .retain(|(_, frame)| Some(frame.as_str()) != gone);
            }
            "Page.fileChooserOpened" => {
                let Some(node) = event.params["backendNodeId"].as_i64() else {
                    warn!(
                        page = target,
                        "a page asks for files with no input to give them"
                    );
                    return;
                };
                // The page's request is still taken from the browser, which would show a
                // dialog of its own, and left without an answer: the page gets no files.
                if !self.uploads {
                    return;
                }
                self.asked += 1;
                let asked = Open {
                    request: Request {
                        id: self.asked,
                        target: target.clone(),
                        multiple: event.params["mode"] == "selectMultiple",
                    },
                    session,
                    node,
                };
                self.pages.open.send_modify(|open| {
                    // A page asks for one thing at a time.
                    open.retain(|before| before.request.target != target);
                    open.push(asked);
                });
            }
            "Runtime.bindingCalled" if event.params["name"] == CALL => {
                let said = event.params["payload"].as_str().unwrap_or_default();
                // The page's own scripts do not reach the binding, which is of the
                // runner's world: what is no menu is the runner's script gone wrong.
                match serde_json::from_str::<Menu>(said) {
                    // Nobody watching is fine.
                    Ok(menu) => drop(self.pages.menus.send(Menu { target, ..menu })),
                    Err(err) => warn!(page = target, %err, "a page's menu is not read"),
                }
            }
            _ => {}
        }
    }
}

/// Attaches the page and has it ask here; gives the session it is attached as.
async fn attach(browser: &cdp::Client, page: &str) -> anyhow::Result<String> {
    let attached = browser
        .call(
            "Target.attachToTarget",
            json!({ "targetId": page, "flatten": true }),
        )
        .await?;
    let session = attached["sessionId"]
        .as_str()
        .context("the browser attached no session")?;
    let call = |method: &'static str, params: Value| browser.call_in(Some(session), method, params);
    call("Page.enable", json!({})).await?;
    // Without it the page's calls are not told.
    call("Runtime.enable", json!({})).await?;
    call(
        "Page.setInterceptFileChooserDialog",
        json!({ "enabled": true }),
    )
    .await?;
    call(
        "Runtime.addBinding",
        json!({ "name": CALL, "executionContextName": WORLD }),
    )
    .await?;
    // In the pages to come, and in the one there is.
    call(
        "Page.addScriptToEvaluateOnNewDocument",
        json!({ "source": SCRIPT, "worldName": WORLD }),
    )
    .await?;
    let frames = call("Page.getFrameTree", json!({})).await?;
    if let Some(frame) = frames["frameTree"]["frame"]["id"].as_str() {
        let world = call(
            "Page.createIsolatedWorld",
            json!({ "frameId": frame, "worldName": WORLD }),
        )
        .await?;
        call(
            "Runtime.evaluate",
            json!({ "expression": SCRIPT, "contextId": world["executionContextId"] }),
        )
        .await?;
    }
    attach_frames(browser, session).await?;
    Ok(session.to_owned())
}

/// Has the browser attach the frames that are pages of their own to it, those of other
/// sites, as they come: what one of them asks is not told to the page around it.
async fn attach_frames(browser: &cdp::Client, session: &str) -> anyhow::Result<()> {
    let attach = json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true });
    browser
        .call_in(Some(session), "Target.setAutoAttach", attach)
        .await?;
    Ok(())
}

/// Has a frame ask here for files, and the frames in it attached in turn.
async fn attach_frame(browser: &cdp::Client, session: &str) -> anyhow::Result<()> {
    let call = |method: &'static str, params: Value| browser.call_in(Some(session), method, params);
    call("Page.enable", json!({})).await?;
    call(
        "Page.setInterceptFileChooserDialog",
        json!({ "enabled": true }),
    )
    .await?;
    attach_frames(browser, session).await
}
