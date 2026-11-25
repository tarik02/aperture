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
use tracing::{info, warn};

use crate::{cdp, live::sound::Sound};

const MESSAGE_LIMIT: usize = 1024 * 1024;
/// How long the extension waits for a window it opened, or a tab it moved, to show up here.
const SETTLE_WITHIN: Duration = Duration::from_secs(5);
/// Pages change their titles and close without the extension saying so.
const RECONCILE_EVERY: Duration = Duration::from_millis(500);

/// The narrowest the browser makes a window, in logical pixels: asked for less, it stays
/// this wide. A page shown as on a phone that is to be narrower is drawn larger into a
/// window this wide.
pub const NARROWEST: u32 = 500;

/// The viewport a tab gets when it comes to be shown as on a phone and nobody gave it one.
const PHONE: Viewport = Viewport {
    width: 412,
    height: 915,
    scale: 2.625,
};

/// How a tab's pages are shown, as it is set.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// As on what whoever holds the tab uses: as on a phone once someone holds it from
    /// one, as on a desktop once someone holds it from anything else.
    #[default]
    Auto,
    Desktop,
    Mobile,
}

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
    /// The page's viewport, in its logical pixels.
    pub width: u32,
    pub height: u32,
    /// Pixels to a logical pixel of the page.
    pub scale: f64,
    /// How many logical pixels of the window one of the page takes: more than one for a
    /// page narrower than a window gets.
    pub zoom: f64,
    pub mode: Mode,
    /// The page is shown as on a phone: what the mode comes to.
    pub mobile: bool,
    /// How many times the page was to load again for being shown another way.
    pub loads: u32,
    /// The page that opened this one, where a page did.
    pub opener: Option<String>,
}

/// How a tab that is yet to come is shown from its start.
#[derive(Debug, Clone, Copy)]
pub struct Like {
    pub mode: Mode,
    pub mobile: bool,
    /// The page's viewport, for one shown as on a phone.
    pub viewport: Option<Viewport>,
}

impl Like {
    /// As the target is shown.
    pub fn of(target: &Target) -> Self {
        Self {
            mode: target.mode,
            mobile: target.mobile,
            viewport: target.mobile.then_some(Viewport {
                width: target.width,
                height: target.height,
                scale: target.scale,
            }),
        }
    }
}

/// The target a tab's number or a target's id names, as whoever names one may give
/// either.
pub fn named<'a>(targets: &'a [Target], named: &str) -> Option<&'a Target> {
    let tab = named.parse::<u32>().ok();
    targets
        .iter()
        .find(|target| Some(target.tab) == tab || target.id.eq_ignore_ascii_case(named))
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
    opener: Option<String>,
    mode: Mode,
    mobile: bool,
    /// The page's viewport as it was last given here; the window's own without.
    asked: Option<Viewport>,
    /// The viewport the tab had before it came to be shown as on a phone.
    desktop: Option<Viewport>,
    loads: u32,
}

impl Ready {
    /// The page's viewport where it is narrower than a window gets.
    fn narrow(&self) -> Option<Viewport> {
        self.asked
            .filter(|asked| self.mobile && asked.width < NARROWEST)
    }

    /// Takes a viewport for the page, and gives the one its window gets for it.
    fn place(&mut self, asked: Viewport) -> Viewport {
        let asked = asked.bounded();
        self.asked = Some(asked);
        match self.narrow() {
            Some(narrow) => {
                let zoom = f64::from(NARROWEST) / f64::from(narrow.width);
                Viewport {
                    width: NARROWEST,
                    height: (f64::from(narrow.height) * zoom).round() as u32,
                    scale: narrow.scale / zoom,
                }
            }
            None => asked,
        }
    }

    /// Shows the page as on a phone, or no longer: gives the viewport its window gets,
    /// when that changes how it is shown. `now` is the page's viewport as it is.
    fn show(&mut self, mobile: bool, now: Viewport, otherwise: Viewport) -> Option<Viewport> {
        if self.mobile == mobile {
            return None;
        }
        self.mobile = mobile;
        let next = if mobile {
            // A viewport as narrow as a phone's was asked for a phone already: the tab
            // keeps it, and had none of a desktop's to come back to.
            let asked = self.asked.filter(|asked| asked.width < NARROWEST);
            self.desktop = asked.is_none().then_some(now);
            asked.unwrap_or(PHONE)
        } else {
            self.desktop.take().unwrap_or(otherwise)
        };
        Some(self.place(next))
    }
}

/// What is kept of a tab from one run of the session to the next: the browser brings the
/// tab back, and it is told from the others by its page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct KeptTab {
    tab: u32,
    url: String,
    /// The viewport of the tab's page.
    width: u32,
    height: u32,
    scale: f64,
    mode: Mode,
    mobile: bool,
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
    /// How pages that are yet to be targets are shown once they are, by their ids.
    expected: HashMap<String, Like>,
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
    /// What the extension tells of the tabs' sound goes here.
    sound: Arc<Sound>,
    /// The viewport a tab starts with.
    viewport: Viewport,
}

/// The session's tabs, for giving them another viewport and another way to be shown.
#[derive(Clone)]
pub struct Tabs(Arc<Inner>);

impl Tabs {
    /// Gives the target's page a viewport, as near to the one asked for as it can be
    /// given; it keeps its scale when none is named.
    pub fn resize(&self, target: &str, width: u32, height: u32, scale: Option<f64>) {
        self.0.change(target, |ready, now, _| {
            let scale = scale.unwrap_or(now.scale);
            Some(ready.place(Viewport {
                width,
                height,
                scale,
            }))
        });
    }

    /// Sets how the target's pages are shown. `phone` is whether whoever sets it uses a
    /// phone, which is what `Mode::Auto` comes to; without, the tab stays as it is shown.
    /// Where that changes how it is shown and `reload` is set, its page loads again.
    /// False when there is no such target.
    pub fn set_mode(&self, target: &str, mode: Mode, phone: Option<bool>, reload: bool) -> bool {
        self.0.change(target, |ready, now, otherwise| {
            ready.mode = mode;
            let mobile = match mode {
                Mode::Desktop => false,
                Mode::Mobile => true,
                Mode::Auto => phone.unwrap_or(ready.mobile),
            };
            let placed = ready.show(mobile, now, otherwise);
            if placed.is_some() && reload {
                ready.loads += 1;
            }
            placed
        })
    }

    /// Someone holds the target's tab, from a phone or not: a tab that goes by its holder
    /// is shown as on what they use. The page it has is left as it loaded.
    pub fn drive(&self, target: &str, phone: bool) {
        self.0.change(target, |ready, now, otherwise| {
            (ready.mode == Mode::Auto)
                .then(|| ready.show(phone, now, otherwise))
                .flatten()
        });
    }

    /// Keeps pages from becoming targets until it is dropped: a tab that is being opened
    /// is told how it is to be shown before it is one, or it would come as a desktop's.
    pub async fn opening(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.0.reconciling.lock().await
    }

    /// The page, which is yet to be a target, is shown this way once it is one.
    pub fn expect(&self, page: String, like: Like) {
        let mut state = self.0.state.lock().expect("not poisoned");
        state.expected.insert(page, like);
    }
}

pub struct Registry {
    inner: Arc<Inner>,
    browser: watch::Sender<Option<cdp::Client>>,
}

impl Registry {
    /// Listens for the extension on `socket`. Targets come once the browser is attached.
    /// The tabs are kept in the file `kept` from one run of the session to the next.
    pub fn bind(
        socket: &Path,
        compositor: Handle,
        kept: PathBuf,
        sound: Arc<Sound>,
        viewport: Viewport,
    ) -> std::io::Result<Self> {
        // The socket an earlier run left; binding says what else is in the way.
        let _ = std::fs::remove_file(socket);
        let listener = UnixListener::bind(socket)?;
        let (browser, attached) = watch::channel(None);
        // Tabs whose numbers are not known again would be given numbers that were theirs.
        let before: Kept = match std::fs::read(&kept) {
            Ok(read) => serde_json::from_slice(&read).map_err(std::io::Error::other)?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Kept::default(),
            Err(err) => return Err(err),
        };
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
            sound,
            viewport,
        });

        tokio::spawn({
            let inner = inner.clone();
            async move {
                loop {
                    let stream = match listener.accept().await {
                        Ok((stream, _)) => stream,
                        Err(err) => {
                            warn!("the extension's socket took no connection: {err}");
                            sleep(RECONCILE_EVERY).await;
                            continue;
                        }
                    };
                    let inner = inner.clone();
                    tokio::spawn(async move {
                        if let Err(err) = inner.serve(stream).await {
                            warn!("the extension's connection ended: {err:#}");
                        }
                        inner.sound.untap();
                    });
                }
            }
        });
        tokio::spawn({
            let inner = Arc::downgrade(&inner);
            async move {
                // What the last pass failed of, told once for as long as it stays the same.
                let mut failing: Option<String> = None;
                loop {
                    sleep(RECONCILE_EVERY).await;
                    let Some(inner) = inner.upgrade() else {
                        return;
                    };
                    // Nothing to bring in line before there is a browser to ask.
                    if inner.browser.borrow().is_none() {
                        continue;
                    }
                    let failed = inner.reconcile().await.err().map(|err| format!("{err:#}"));
                    if let Some(err) = failed.as_ref().filter(|_| failed != failing) {
                        warn!("failed to reconcile targets: {err}");
                    }
                    failing = failed;
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

    pub fn tabs(&self) -> Tabs {
        Tabs(self.inner.clone())
    }
}

impl Inner {
    /// Changes how a target is shown: `change` is given the target, its page's viewport
    /// as it is and the one a tab starts with, and gives the viewport the target's window
    /// gets when that is another. False when there is no such target.
    fn change(
        &self,
        target: &str,
        change: impl FnOnce(&mut Ready, Viewport, Viewport) -> Option<Viewport>,
    ) -> bool {
        let placed = {
            let windows = self.compositor.windows();
            let windows = windows.borrow();
            let mut state = self.state.lock().expect("not poisoned");
            let Some(ready) = state.ready.get_mut(target) else {
                return false;
            };
            let Some(window) = windows.iter().find(|window| window.id == ready.window) else {
                return false;
            };
            let now = ready.narrow().unwrap_or(Viewport {
                width: window.width,
                height: window.height,
                scale: window.scale,
            });
            change(ready, now, self.viewport).map(|placed| (ready.window, placed))
        };
        if let Some((window, placed)) = placed {
            self.compositor.set_viewport(window, placed);
        }
        self.publish();
        true
    }

    /// Requests and their answers are framed as Chromium frames native messages: the
    /// length, in the machine's byte order, then JSON. What the extension tells of the
    /// tabs' sound comes the same way, and is not answered.
    async fn serve(&self, mut stream: UnixStream) -> anyhow::Result<()> {
        loop {
            let mut length = [0; 4];
            match stream.read_exact(&mut length).await {
                Ok(_) => {}
                // The extension's host ended, between two messages.
                Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
                Err(err) => return Err(err.into()),
            }
            let length = u32::from_ne_bytes(length) as usize;
            ensure!(length <= MESSAGE_LIMIT, "a message of {length} bytes");
            let mut body = vec![0; length];
            stream.read_exact(&mut body).await?;

            let message: Value = serde_json::from_slice(&body)?;
            let of_sound = message["type"]
                .as_str()
                .is_some_and(|kind| kind.starts_with("sound."));
            if of_sound {
                if let Err(err) = self.sound.told(message) {
                    warn!("the extension said something odd about a tab's sound: {err:#}");
                }
                continue;
            }
            let answer = match serde_json::from_value::<Request>(message) {
                Ok(request) => match self.handle(request.kind).await {
                    Ok(()) => json!({ "id": request.id, "ok": true }),
                    Err(err) => {
                        warn!("refused the extension: {err:#}");
                        json!({ "id": request.id, "ok": false, "error": format!("{err:#}") })
                    }
                },
                Err(err) => {
                    warn!("the extension asked for what is not understood: {err}");
                    json!({ "id": "", "ok": false, "error": err.to_string() })
                }
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
                self.compositor.expect(nonce).await?;
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

        let pages = pages(&browser).await?;
        let (fresh, placed) = self.state.lock().expect("not poisoned").settle(&pages);
        for (window, viewport) in placed {
            self.compositor.set_viewport(window, viewport);
        }
        for page in fresh {
            if let Err(err) = focus_page(&browser, &page).await {
                warn!(page, "a page takes no keys until it is clicked: {err:#}");
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
                let narrow = ready.narrow();
                let page = narrow.unwrap_or(Viewport {
                    width: window.width,
                    height: window.height,
                    scale: window.scale,
                });
                Some(Target {
                    id: id.clone(),
                    tab: ready.tab,
                    browser_tab: ready.browser_tab,
                    window: ready.window,
                    title: ready.title.clone(),
                    url: ready.url.clone(),
                    width: page.width,
                    height: page.height,
                    scale: page.scale,
                    zoom: narrow
                        .map_or(1.0, |narrow| f64::from(NARROWEST) / f64::from(narrow.width)),
                    mode: ready.mode,
                    mobile: ready.mobile,
                    loads: ready.loads,
                    opener: ready.opener.clone(),
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
                mode: target.mode,
                mobile: target.mobile,
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

impl State {
    /// Takes in the browser's pages: a settled window with exactly one page is that page's
    /// target, and a page that is gone takes its target along. Gives the pages that became
    /// targets, and the viewports their windows get where they start with one of their
    /// own: the tabs of the last run that are back, and those that start as on a phone.
    fn settle(&mut self, pages: &[Page]) -> (Vec<String>, Vec<(WindowId, Viewport)>) {
        let mut fresh = Vec::new();
        let mut placed = Vec::new();
        let unresolved = pages.iter().any(|page| page.window.is_none());
        for (chromium_window, binding) in &self.bindings {
            if !binding.settled {
                continue;
            }
            let inside: Vec<&Page> = pages
                .iter()
                .filter(|page| page.window == Some(*chromium_window))
                .collect();
            let shows = |page: &Page| {
                self.ready
                    .get(&page.id)
                    .is_some_and(|ready| ready.window == binding.window)
            };
            // A tab a page just opened shares its opener's window, or has no window yet,
            // until the extension moves it to one of its own. The opener is still there,
            // so its target stays instead of going and coming back.
            let shared = inside.len() > 1 && inside.iter().any(|page| shows(page));
            if unresolved || shared {
                continue;
            }
            let [page] = inside[..] else {
                self.ready
                    .retain(|_, ready| ready.chromium_window != *chromium_window);
                continue;
            };
            if shows(page) {
                continue;
            }
            // A page between two documents has no address for a moment, and a tab of the
            // last run is known by its address: it is a target once it has one again.
            if page.url.is_empty() && !self.returning.is_empty() {
                continue;
            }
            info!(page = %page.id, window = binding.window.0, "target ready");
            fresh.push(page.id.clone());
            self.next_order += 1;
            let back = self
                .returning
                .iter()
                .position(|kept| kept.url == page.url)
                .map(|at| self.returning.remove(at));
            let expected = self.expected.remove(&page.id);
            // A tab a page opened is shown as its opener is.
            let opener = page
                .opener
                .as_ref()
                .and_then(|opener| self.ready.get(opener));
            let (tab, like) = match back {
                Some(back) => {
                    let like = Like {
                        mode: back.mode,
                        mobile: back.mobile,
                        viewport: Some(Viewport {
                            width: back.width,
                            height: back.height,
                            scale: back.scale,
                        }),
                    };
                    (back.tab, like)
                }
                None => {
                    self.last_tab += 1;
                    let like = expected.or(opener.map(|opener| Like {
                        mode: opener.mode,
                        mobile: opener.mobile,
                        viewport: opener.asked.filter(|_| opener.mobile),
                    }));
                    let like = like.unwrap_or(Like {
                        mode: Mode::Auto,
                        mobile: false,
                        viewport: None,
                    });
                    (self.last_tab, like)
                }
            };
            let mut ready = Ready {
                chromium_window: *chromium_window,
                window: binding.window,
                title: String::new(),
                url: String::new(),
                order: self.next_order,
                tab,
                browser_tab: binding.tab,
                opener: page.opener.clone(),
                mode: like.mode,
                mobile: like.mobile,
                asked: None,
                desktop: None,
                loads: 0,
            };
            let viewport = like.viewport.or(like.mobile.then_some(PHONE));
            if let Some(viewport) = viewport {
                placed.push((binding.window, ready.place(viewport)));
            }
            self.ready.insert(page.id.clone(), ready);
        }
        self.ready.retain(|id, ready| {
            let Some(page) = pages.iter().find(|page| page.id == *id) else {
                info!(page = %id, "target closed");
                return false;
            };
            ready.title.clone_from(&page.title);
            // A page that loads has no address until its document comes. The tab keeps
            // the one it had: it is what the tab is known by when the session runs again,
            // and the session may be suspended at any moment.
            if !page.url.is_empty() {
                ready.url.clone_from(&page.url);
            }
            true
        });
        // A page that is gone before it was a target is expected no longer.
        self.expected
            .retain(|id, _| pages.iter().any(|page| page.id == *id));
        (fresh, placed)
    }
}

/// The browser's pages that are tabs, each with Chromium's id of its window.
async fn pages(browser: &cdp::Client) -> Result<Vec<Page>, cdp::Error> {
    let mut pages = Vec::new();
    let listed = browser.call("Target.getTargets", json!({})).await?;
    for info in listed["targetInfos"].as_array().into_iter().flatten() {
        let (Some(id), Some(url)) = (info["targetId"].as_str(), info["url"].as_str()) else {
            continue;
        };
        // The session's extension has pages of its own, which are nobody's tabs.
        let own = url.starts_with("chrome-extension://");
        if info["type"] != "page" || own || url.starts_with("devtools://") {
            continue;
        }
        let window = browser.call("Browser.getWindowForTarget", json!({ "targetId": id }));
        let window = match window.await {
            Ok(window) => window["windowId"].as_i64(),
            // A page that has no window yet, or is gone since it was listed.
            Err(cdp::Error::Refused(_) | cdp::Error::Detached) => None,
            Err(err @ cdp::Error::Gone) => return Err(err),
        };
        pages.push(Page {
            id: id.to_owned(),
            title: info["title"].as_str().unwrap_or_default().to_owned(),
            url: url.to_owned(),
            window,
            opener: info["openerId"].as_str().map(str::to_owned),
        });
    }
    Ok(pages)
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
    opener: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "https://example.test/";

    fn page(id: &str, url: &str) -> Page {
        Page {
            id: id.to_owned(),
            title: String::new(),
            url: url.to_owned(),
            window: Some(1),
            opener: None,
        }
    }

    /// A state whose one Chromium window is settled and shows nothing yet.
    fn settled(returning: Vec<KeptTab>) -> State {
        let mut state = State {
            returning,
            ..State::default()
        };
        state.bindings.insert(
            1,
            Binding {
                tab: 7,
                window: WindowId(3),
                settled: true,
            },
        );
        state
    }

    fn kept(tab: u32) -> KeptTab {
        KeptTab {
            tab,
            url: PAGE.to_owned(),
            width: 412,
            height: 915,
            scale: 2.625,
            mode: Mode::Mobile,
            mobile: true,
        }
    }

    #[test]
    fn a_tab_keeps_its_address_while_its_page_loads_again() {
        let mut state = settled(Vec::new());
        state.settle(&[page("a", PAGE)]);
        state.settle(&[page("a", "")]);
        assert_eq!(state.ready["a"].url, PAGE);
        state.settle(&[page("a", "https://example.test/next")]);
        assert_eq!(state.ready["a"].url, "https://example.test/next");
    }

    #[test]
    fn a_tab_of_the_last_run_is_known_once_its_page_has_an_address() {
        let mut state = settled(vec![kept(2)]);
        state.last_tab = 3;
        state.settle(&[page("a", "")]);
        assert!(state.ready.is_empty());
        state.settle(&[page("a", PAGE)]);
        let ready = &state.ready["a"];
        assert_eq!(
            (ready.tab, ready.mode, ready.mobile),
            (2, Mode::Mobile, true)
        );
        assert!(state.returning.is_empty());
    }

    #[test]
    fn a_page_without_an_address_is_a_target_when_no_tab_is_to_come_back() {
        let mut state = settled(Vec::new());
        state.settle(&[page("a", "")]);
        assert_eq!(state.ready["a"].tab, 1);
    }
}
