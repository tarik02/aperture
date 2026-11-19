//! The session's browser targets: its pages, each joined to the window that shows it.
//!
//! Chromium puts several tabs in one window, and only the active one draws there, so a
//! window alone says nothing about a page. The session's extension keeps every page in a
//! window of its own and reports here, through its native messaging host, what it does:
//!
//! 1. `binding.prepare` with a nonce, before it opens a window: the compositor tags the next
//!    window with the nonce.
//! 2. `binding.bind` with the nonce, Chromium's id of the window it opened and the tab it
//!    will move there: the tagged window is that Chromium window.
//! 3. `window.settled` once the tab is alone in the window.
//!
//! A settled window that DevTools says holds exactly one page is a target, named by the
//! page's DevTools target id. Windows that are not, such as one a tab is still moving out
//! of, are shown to nobody.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, bail, ensure};
use aperture_compositor::{Handle, Viewport, WindowId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::watch,
    time::{Instant, sleep, timeout},
};
use tracing::{debug, info, warn};

use crate::cdp;

/// The extension's id, which follows from the key in its manifest.
pub const EXTENSION_ID: &str = "imdifnnggmlpoochobfcpghdppldpmjl";
/// The name the extension asks Chromium for its native messaging host by.
pub const NATIVE_HOST: &str = "me.tarik02.aperture.tab_window_enforcer";

const MESSAGE_LIMIT: usize = 1024 * 1024;
/// How long the extension waits for a window it opened, or a tab it moved, to show up here.
const SETTLE_WITHIN: Duration = Duration::from_secs(5);
/// Pages change their titles and close without the extension saying so.
const RECONCILE_EVERY: Duration = Duration::from_millis(500);

/// A page and the window that shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    /// The page's DevTools target id, which is another one each time the session runs.
    pub id: String,
    /// The tab's number, which stays the tab's when the session is suspended and resumed.
    pub tab: u32,
    /// The browser's own id of the tab, which the session's extensions know it by.
    pub browser_tab: i64,
    pub window: WindowId,
    pub title: String,
    pub url: String,
    /// In logical pixels.
    pub width: u32,
    pub height: u32,
    /// Pixels to a logical pixel.
    pub scale: f64,
}

#[derive(Deserialize)]
struct Request {
    id: String,
    #[serde(flatten)]
    kind: Kind,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Kind {
    #[serde(rename = "binding.prepare")]
    Prepare { nonce: String },
    #[serde(rename = "binding.cancel")]
    Cancel { nonce: String },
    #[serde(rename = "binding.bind", rename_all = "camelCase")]
    Bind {
        nonce: String,
        window_id: i64,
        tab_id: i64,
    },
    #[serde(rename = "window.settled", rename_all = "camelCase")]
    Settled { window_id: i64, tab_id: i64 },
    #[serde(rename = "window.closed", rename_all = "camelCase")]
    Closed { window_id: i64 },
}

/// A Chromium window the extension opened for one tab.
struct Binding {
    tab: i64,
    window: WindowId,
    settled: bool,
}

struct Ready {
    /// Chromium's id of the window.
    chromium_window: i64,
    window: WindowId,
    title: String,
    url: String,
    /// Targets are listed in the order they came to be.
    order: u64,
    tab: u32,
    browser_tab: i64,
}

/// What is kept of a tab from one run of the session to the next: the browser brings the
/// tab back, and it is told from the others by its page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct KeptTab {
    tab: u32,
    url: String,
    /// The tab's viewport.
    width: u32,
    height: u32,
    scale: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Kept {
    /// The last number a tab was given: none is given twice.
    last: u32,
    tabs: Vec<KeptTab>,
}

#[derive(Default)]
struct State {
    bindings: HashMap<i64, Binding>,
    ready: HashMap<String, Ready>,
    next_order: u64,
    last_tab: u32,
    /// The tabs of the session's last run that the browser has yet to bring back.
    returning: Vec<KeptTab>,
    /// What the file of kept tabs holds.
    kept: Kept,
    /// The tabs are kept as they are, whatever becomes of them: the session is ending.
    frozen: bool,
}

/// How long the browser has to bring back the tabs of the session's last run. A tab that
/// opens later is a new one, whatever its page.
const RETURN_WITHIN: Duration = Duration::from_secs(30);

struct Inner {
    compositor: Handle,
    browser: watch::Receiver<Option<cdp::Client>>,
    state: Mutex<State>,
    /// One pass at a time: passes read the browser's targets and then change the state.
    reconciling: tokio::sync::Mutex<()>,
    targets: watch::Sender<Vec<Target>>,
    /// Where the tabs are kept between runs.
    kept: PathBuf,
}

pub struct Registry {
    inner: Arc<Inner>,
    browser: watch::Sender<Option<cdp::Client>>,
}

impl Registry {
    /// Listens for the extension on `socket`. Targets come once the browser is attached.
    /// The tabs are kept in the file `kept` from one run of the session to the next.
    pub fn bind(socket: &Path, compositor: Handle, kept: PathBuf) -> std::io::Result<Self> {
        let _ = std::fs::remove_file(socket);
        let listener = UnixListener::bind(socket)?;
        let (browser, attached) = watch::channel(None);
        let before: Kept = std::fs::read(&kept)
            .ok()
            .and_then(|kept| serde_json::from_slice(&kept).ok())
            .unwrap_or_default();
        let state = State {
            last_tab: before.last,
            returning: before.tabs.clone(),
            kept: before,
            ..State::default()
        };
        let inner = Arc::new(Inner {
            compositor,
            browser: attached,
            state: Mutex::new(state),
            reconciling: tokio::sync::Mutex::default(),
            targets: watch::Sender::new(Vec::new()),
            kept,
        });

        tokio::spawn({
            let inner = inner.clone();
            async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let inner = inner.clone();
                    tokio::spawn(async move {
                        if let Err(err) = inner.serve(stream).await {
                            debug!("the extension's connection ended: {err:#}");
                        }
                    });
                }
            }
        });
        tokio::spawn({
            let inner = Arc::downgrade(&inner);
            async move {
                loop {
                    sleep(RECONCILE_EVERY).await;
                    let Some(inner) = inner.upgrade() else {
                        return;
                    };
                    if let Err(err) = inner.reconcile().await {
                        debug!("failed to reconcile targets: {err:#}");
                    }
                }
            }
        });
        Ok(Self { inner, browser })
    }

    pub fn attach(&self, browser: cdp::Client) {
        self.browser.send_replace(Some(browser));
        let inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            sleep(RETURN_WITHIN).await;
            if let Some(inner) = inner.upgrade() {
                inner.state.lock().expect("not poisoned").returning.clear();
                inner.publish();
            }
        });
    }

    /// Keeps the tabs as they are now for the session's next run, whatever becomes of
    /// them from here on: the browser takes them down one by one as it closes.
    pub fn freeze(&self) {
        self.inner.state.lock().expect("not poisoned").frozen = true;
    }

    pub fn targets(&self) -> watch::Receiver<Vec<Target>> {
        self.inner.targets.subscribe()
    }
}

impl Inner {
    /// Requests and their answers are framed as Chromium frames native messages: the
    /// length, in the machine's byte order, then JSON.
    async fn serve(&self, mut stream: UnixStream) -> anyhow::Result<()> {
        loop {
            let mut length = [0; 4];
            if stream.read_exact(&mut length).await.is_err() {
                return Ok(());
            }
            let length = u32::from_ne_bytes(length) as usize;
            ensure!(length <= MESSAGE_LIMIT, "a message of {length} bytes");
            let mut body = vec![0; length];
            stream.read_exact(&mut body).await?;

            let answer = match serde_json::from_slice::<Request>(&body) {
                Ok(request) => match self.handle(request.kind).await {
                    Ok(()) => json!({ "id": request.id, "ok": true }),
                    Err(err) => {
                        warn!("refused the extension: {err:#}");
                        json!({ "id": request.id, "ok": false, "error": format!("{err:#}") })
                    }
                },
                Err(err) => json!({ "id": "", "ok": false, "error": err.to_string() }),
            };
            let answer = answer.to_string();
            stream
                .write_all(&(answer.len() as u32).to_ne_bytes())
                .await?;
            stream.write_all(answer.as_bytes()).await?;
        }
    }

    async fn handle(&self, kind: Kind) -> anyhow::Result<()> {
        match kind {
            Kind::Prepare { nonce } => {
                self.compositor.expect(nonce);
                Ok(())
            }
            Kind::Cancel { nonce } => {
                self.compositor.forget(nonce);
                Ok(())
            }
            Kind::Bind {
                nonce,
                window_id,
                tab_id,
            } => {
                let window = self.tagged(&nonce).await?;
                self.state.lock().expect("not poisoned").bindings.insert(
                    window_id,
                    Binding {
                        tab: tab_id,
                        window,
                        settled: false,
                    },
                );
                Ok(())
            }
            Kind::Settled { window_id, tab_id } => {
                {
                    let mut state = self.state.lock().expect("not poisoned");
                    match state.bindings.get_mut(&window_id) {
                        Some(binding) if binding.tab == tab_id => binding.settled = true,
                        _ => bail!("window {window_id} has no binding for tab {tab_id}"),
                    }
                }
                // The extension goes on once the window is a target, so that it never
                // leaves a page without one for longer than it must.
                let deadline = Instant::now() + SETTLE_WITHIN;
                loop {
                    let reconciled = self.reconcile().await;
                    let ready = self
                        .state
                        .lock()
                        .expect("not poisoned")
                        .ready
                        .values()
                        .any(|ready| ready.chromium_window == window_id);
                    if ready {
                        return Ok(());
                    }
                    if Instant::now() >= deadline {
                        return reconciled.and_then(|()| {
                            bail!("window {window_id} did not become a target in time")
                        });
                    }
                    sleep(Duration::from_millis(50)).await;
                }
            }
            Kind::Closed { window_id } => {
                {
                    let mut state = self.state.lock().expect("not poisoned");
                    state.bindings.remove(&window_id);
                    state
                        .ready
                        .retain(|_, ready| ready.chromium_window != window_id);
                }
                self.publish();
                Ok(())
            }
        }
    }

    /// The window the compositor tagged `nonce`, once it has content.
    async fn tagged(&self, nonce: &str) -> anyhow::Result<WindowId> {
        let mut windows = self.compositor.windows();
        let found = async {
            loop {
                let window = windows
                    .borrow_and_update()
                    .iter()
                    .find(|window| window.tag.as_deref() == Some(nonce))
                    .map(|window| window.id);
                if let Some(window) = window {
                    return Ok(window);
                }
                windows.changed().await.context("the compositor stopped")?;
            }
        };
        timeout(SETTLE_WITHIN, found)
            .await
            .context("the window the extension opened did not show up")?
    }

    /// Brings the targets in line with the browser's pages: a settled window with exactly
    /// one page is that page's target, and a page that is gone takes its target along.
    async fn reconcile(&self) -> anyhow::Result<()> {
        let _reconciling = self.reconciling.lock().await;
        let browser = self
            .browser
            .borrow()
            .clone()
            .context("the browser is not attached yet")?;

        // Pages, each with Chromium's id of its window; none for a page that has no
        // window yet.
        let mut pages = Vec::new();
        let listed = browser.call("Target.getTargets", json!({})).await?;
        for info in listed["targetInfos"].as_array().into_iter().flatten() {
            let (Some(id), Some(url)) = (info["targetId"].as_str(), info["url"].as_str()) else {
                continue;
            };
            // The session's extensions have pages of their own, which are nobody's tabs.
            let own = url.starts_with("chrome-extension://");
            if info["type"] != "page" || own || url.starts_with("devtools://") {
                continue;
            }
            let window = browser
                .call("Browser.getWindowForTarget", json!({ "targetId": id }))
                .await
                .ok()
                .and_then(|window| window["windowId"].as_i64());
            pages.push(Page {
                id: id.to_owned(),
                title: info["title"].as_str().unwrap_or_default().to_owned(),
                url: url.to_owned(),
                window,
            });
        }

        let mut fresh = Vec::new();
        // The tabs that are back, each with the window it is in.
        let mut returned = Vec::new();
        {
            let mut state = self.state.lock().expect("not poisoned");
            let state = &mut *state;
            let unresolved = pages.iter().any(|page| page.window.is_none());
            for (chromium_window, binding) in &state.bindings {
                if !binding.settled {
                    continue;
                }
                let inside: Vec<&Page> = pages
                    .iter()
                    .filter(|page| page.window == Some(*chromium_window))
                    .collect();
                // A tab a page just opened shares its opener's window, or has no window
                // yet, until the extension moves it to one of its own. The opener is still
                // there, so its target stays instead of going and coming back.
                let shared = inside.len() > 1
                    && inside.iter().any(|page| {
                        state
                            .ready
                            .get(&page.id)
                            .is_some_and(|ready| ready.window == binding.window)
                    });
                if unresolved || shared {
                    continue;
                }
                let [page] = inside[..] else {
                    state
                        .ready
                        .retain(|_, ready| ready.chromium_window != *chromium_window);
                    continue;
                };
                let known = state
                    .ready
                    .get(&page.id)
                    .is_some_and(|ready| ready.window == binding.window);
                if !known {
                    info!(page = %page.id, window = binding.window.0, "target ready");
                    fresh.push(page.id.clone());
                    state.next_order += 1;
                    let back = state
                        .returning
                        .iter()
                        .position(|kept| kept.url == page.url)
                        .map(|at| state.returning.remove(at));
                    let tab = match back {
                        Some(back) => {
                            returned.push((binding.window, back.clone()));
                            back.tab
                        }
                        None => {
                            state.last_tab += 1;
                            state.last_tab
                        }
                    };
                    state.ready.insert(
                        page.id.clone(),
                        Ready {
                            chromium_window: *chromium_window,
                            window: binding.window,
                            title: String::new(),
                            url: String::new(),
                            order: state.next_order,
                            tab,
                            browser_tab: binding.tab,
                        },
                    );
                }
            }
            state.ready.retain(|id, ready| {
                let Some(page) = pages.iter().find(|page| page.id == *id) else {
                    info!(page = %id, "target closed");
                    return false;
                };
                ready.title.clone_from(&page.title);
                ready.url.clone_from(&page.url);
                true
            });
        }
        for (window, back) in returned {
            let viewport = Viewport {
                width: back.width,
                height: back.height,
                scale: back.scale,
            };
            self.compositor.set_viewport(window, viewport);
        }
        for page in fresh {
            if let Err(err) = focus_page(&browser, &page).await {
                debug!(page, "failed to focus a page: {err:#}");
            }
        }
        self.publish();
        Ok(())
    }

    /// Writes the file of kept tabs, whole or not at all.
    fn keep(&self, kept: &Kept) -> anyhow::Result<()> {
        if let Some(directory) = self.kept.parent() {
            std::fs::create_dir_all(directory)?;
        }
        let aside = self.kept.with_extension("json.new");
        std::fs::write(&aside, serde_json::to_vec(kept)?)?;
        std::fs::rename(&aside, &self.kept)?;
        Ok(())
    }

    /// Tells watchers the targets whose windows have content, in the order they came to be.
    fn publish(&self) {
        let windows = self.compositor.windows();
        let windows = windows.borrow();
        let mut state = self.state.lock().expect("not poisoned");
        let state = &mut *state;
        let mut ready: Vec<(&String, &Ready)> = state.ready.iter().collect();
        ready.sort_by_key(|(_, ready)| ready.order);
        let targets: Vec<Target> = ready
            .into_iter()
            .filter_map(|(id, ready)| {
                let window = windows.iter().find(|window| window.id == ready.window)?;
                Some(Target {
                    id: id.clone(),
                    tab: ready.tab,
                    browser_tab: ready.browser_tab,
                    window: ready.window,
                    title: ready.title.clone(),
                    url: ready.url.clone(),
                    width: window.width,
                    height: window.height,
                    scale: window.scale,
                })
            })
            .collect();
        if !state.frozen {
            // With the tabs that are yet to come back: the session may end before they do.
            let here = targets.iter().map(|target| KeptTab {
                tab: target.tab,
                url: target.url.clone(),
                width: target.width,
                height: target.height,
                scale: target.scale,
            });
            let kept = Kept {
                last: state.last_tab,
                tabs: here.chain(state.returning.iter().cloned()).collect(),
            };
            if kept != state.kept {
                match self.keep(&kept) {
                    Ok(()) => state.kept = kept,
                    Err(err) => warn!("failed to keep the tabs: {err:#}"),
                }
            }
        }
        self.targets.send_if_modified(|published| {
            let changed = *published != targets;
            if changed {
                *published = targets;
            }
            changed
        });
    }
}

/// Puts the browser's own focus on the page. The extension opens a page's window without
/// focus, and there the browser would give keys from the keyboard to nothing, until a click
/// landed on the page.
async fn focus_page(browser: &cdp::Client, page: &str) -> anyhow::Result<()> {
    let attached = browser
        .call(
            "Target.attachToTarget",
            json!({ "targetId": page, "flatten": true }),
        )
        .await?;
    let session = attached["sessionId"]
        .as_str()
        .context("the browser attached no session")?;
    let focused = browser
        .call_in(Some(session), "Page.bringToFront", json!({}))
        .await;
    browser
        .call("Target.detachFromTarget", json!({ "sessionId": session }))
        .await?;
    focused?;
    Ok(())
}

struct Page {
    id: String,
    title: String,
    url: String,
    window: Option<i64>,
}

/// The manifest that tells Chromium where the extension's native messaging host is.
pub fn native_host_manifest(host: &Path) -> Value {
    json!({
        "name": NATIVE_HOST,
        "description": "Aperture's bridge to the session's extension",
        "path": host,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    })
}
