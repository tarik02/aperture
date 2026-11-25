//! What pages ask of whoever uses the session, where the browser would show something of
//! its own that nobody sees: files, when a file input is clicked, and a menu, at a right
//! click. The runner keeps a DevTools session of its own with each page to hear of them,
//! and to take a page elsewhere.

use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    sync::{broadcast, watch},
    time::timeout,
};
use tracing::warn;

use crate::{
    cdp,
    targets::{Like, Tabs, Target},
};

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

/// How long a page that is a target gets to be attached before what is asked of it fails.
const ATTACHED_WITHIN: Duration = Duration::from_secs(5);

/// What a new tab shows when it is asked for with no page to open.
const NEW_TAB: &str = "chrome://newtab/";
/// The name pages call the runner by, and the name of the world of a page the runner's
/// own script runs in, apart from the page's.
const CALL: &str = "apertureMenu";
const WORLD: &str = "aperture";

/// Tells of a right click the page made nothing of: pages with a menu of their own keep
/// theirs. What was under the pointer is looked at when the click comes, and whether the
/// page took it once the page has had it. The browser has a menu of its own for a field,
/// kiosk or not, which is kept from opening where the page left the click alone.
const SCRIPT: &str = r#"(() => {
  if (globalThis.apertureListens) return;
  globalThis.apertureListens = true;
  addEventListener("contextmenu", (event) => {
    const under = event.composedPath().filter((node) => node instanceof Element);
    const link = under.find((node) => node.matches("a[href], area[href]"));
    const image = under.find((node) => node.matches("img"));
    const editable = under.some((node) => node.isContentEditable || node.matches("input, textarea"));
    const text = String(getSelection()).slice(0, 4096);
    let kept = false;
    addEventListener("contextmenu", (after) => {
      if (after !== event || !editable || event.defaultPrevented) return;
      event.preventDefault();
      kept = true;
    }, { once: true });
    setTimeout(() => {
      if (event.defaultPrevented && !kept) return;
      apertureMenu(JSON.stringify({ link: link?.href, image: image?.currentSrc || image?.src, text: text || undefined, editable }));
    });
  }, true);
})()"#;

/// How a page is shown: as the browser shows it, or as on a phone.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Shown {
    mobile: bool,
    /// The page's viewport and how many pixels it draws to a logical one.
    width: u32,
    height: u32,
    scale: f64,
    zoom: f64,
}

impl Shown {
    fn of(target: &Target) -> Self {
        Self {
            mobile: target.mobile,
            width: target.width,
            height: target.height,
            scale: target.scale,
            zoom: target.zoom,
        }
    }
}

/// What a phone's browser of the same make says its platform is. The browser's version
/// and its brands stay the session's browser's own: a phone differs in nothing else.
const PHONE_PLATFORM: &str = "(Linux; Android 10; K)";
const PHONE_MODEL: &str = "Pixel 8";
const PHONE_SYSTEM: &str = "14.0.0";

/// The user agent of a phone's browser of the make and version of this one.
fn phone_agent(own: &str) -> Option<String> {
    let (before, rest) = own.split_once('(')?;
    let (_, after) = rest.split_once(')')?;
    let phone = format!("{before}{PHONE_PLATFORM}{after}");
    Some(phone.replacen(" Safari/", " Mobile Safari/", 1))
}

/// What a page is told to say it is where it is shown as on a phone.
fn phone(agent: &str) -> Value {
    json!({
        "userAgent": agent,
        "platform": "Linux armv81",
        "userAgentMetadata": {
            "platform": "Android",
            "platformVersion": PHONE_SYSTEM,
            "architecture": "",
            "model": PHONE_MODEL,
            "mobile": true,
            "bitness": "",
            "wow64": false,
            "formFactors": ["Mobile"],
        },
    })
}

/// Has a page's scripts told a phone's platform, in the page there is and in every one to
/// come, before anything of the page's own runs. The browser keeps what it is told to say
/// its platform is only until another DevTools session of the page ends, an automation's
/// or anyone's, and with one attached a new document's first scripts read the platform
/// the browser is on beside a phone's user agent.
const SAYS_PHONE: &str = r#"(() => {
  const own = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
  if (!own?.get || own.get.browsers) return;
  const { get } = Object.getOwnPropertyDescriptor({ get platform() { return "Linux armv81"; } }, "platform");
  get.browsers = own.get;
  Object.defineProperty(Navigator.prototype, "platform", { ...own, get });
})()"#;

/// Has the page there is told the browser's own platform again.
const SAYS_BROWSER: &str = r#"(() => {
  const own = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
  if (own?.get?.browsers) Object.defineProperty(Navigator.prototype, "platform", { ...own, get: own.get.browsers });
})()"#;

/// Has a page shown as on a phone, or as the browser shows it. A phone's page gets a
/// phone's user agent with the client hints that go with it, touch in place of a mouse,
/// and a viewport the page lays itself out for as for a phone's.
async fn show(
    browser: &cdp::Client,
    session: &str,
    agent: &str,
    shown: Shown,
    says: &mut Option<String>,
) -> Result<(), cdp::Error> {
    let call = |method: &'static str, params: Value| browser.call_in(Some(session), method, params);
    if !shown.mobile {
        if let Some(identifier) = says.take() {
            call(
                "Page.removeScriptToEvaluateOnNewDocument",
                json!({ "identifier": identifier }),
            )
            .await?;
            call("Runtime.evaluate", json!({ "expression": SAYS_BROWSER })).await?;
        }
        call("Emulation.setUserAgentOverride", json!({ "userAgent": "" })).await?;
        call("Emulation.clearDeviceMetricsOverride", json!({})).await?;
        call(
            "Emulation.setEmitTouchEventsForMouse",
            json!({ "enabled": false }),
        )
        .await?;
        call(
            "Emulation.setTouchEmulationEnabled",
            json!({ "enabled": false }),
        )
        .await?;
        return Ok(());
    }
    call("Emulation.setUserAgentOverride", phone(agent)).await?;
    if says.is_none() {
        let added = call(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": SAYS_PHONE, "runImmediately": true }),
        )
        .await?;
        *says = added["identifier"].as_str().map(str::to_owned);
    }
    let upright = shown.height >= shown.width;
    // No size of its own: the page has the window's, less by what it is drawn larger.
    call(
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": 0,
            "height": 0,
            "deviceScaleFactor": shown.scale,
            "mobile": true,
            "scale": shown.zoom,
            "screenWidth": shown.width,
            "screenHeight": shown.height,
            "positionX": 0,
            "positionY": 0,
            "screenOrientation": {
                "type": if upright { "portraitPrimary" } else { "landscapePrimary" },
                "angle": if upright { 0 } else { 90 },
            },
        }),
    )
    .await?;
    call(
        "Emulation.setTouchEmulationEnabled",
        json!({ "enabled": true, "maxTouchPoints": 5 }),
    )
    .await?;
    // The session's pointer is a mouse to the browser, whoever moves it.
    call(
        "Emulation.setEmitTouchEventsForMouse",
        json!({ "enabled": true, "configuration": "mobile" }),
    )
    .await?;
    Ok(())
}

#[derive(Clone)]
pub struct Pages {
    browser: cdp::Client,
    tabs: Tabs,
    open: watch::Sender<Vec<Open>>,
    menus: broadcast::Sender<Menu>,
    /// The targets' pages by the DevTools session each is attached as.
    attached: Arc<watch::Sender<Vec<(String, String)>>>,
    /// Which ways the history of each target's page goes.
    history: Arc<watch::Sender<HashMap<String, History>>>,
}

/// Whether a page's history has somewhere to go.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct History {
    pub back: bool,
    pub forward: bool,
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
        tabs: Tabs,
        mut targets: watch::Receiver<Vec<Target>>,
        uploads: bool,
    ) -> Self {
        let pages = Self {
            browser: browser.clone(),
            tabs,
            open: watch::Sender::new(Vec::new()),
            menus: broadcast::Sender::new(16),
            attached: Arc::new(watch::Sender::new(Vec::new())),
            history: Arc::new(watch::Sender::new(HashMap::new())),
        };
        let mut follower = Follower {
            // Before any page is attached, so no event of one is missed.
            events: browser.events(),
            pages: pages.clone(),
            uploads,
            asked: 0,
            frames: Vec::new(),
            agent: None,
            shown: HashMap::new(),
            says: HashMap::new(),
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
                        let pages = targets.borrow_and_update().clone();
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
        // A page is told of as a target a moment before it is attached here: what is
        // asked of it right then waits that moment.
        let mut attached = self.attached.subscribe();
        let of_target = |attached: &Vec<(String, String)>| {
            let found = attached.iter().find(|(attached, _)| attached == target);
            found.map(|(_, session)| session.clone())
        };
        let session = timeout(ATTACHED_WITHIN, async {
            loop {
                if let Some(session) = of_target(&attached.borrow_and_update()) {
                    return Some(session);
                }
                attached.changed().await.ok()?;
            }
        });
        let session = session
            .await
            .ok()
            .flatten()
            .context("the page is not attached")?;
        Ok(self.browser.call_in(Some(&session), method, params).await?)
    }

    /// Which ways the history of each target's page goes, as it changes.
    pub fn history(&self) -> watch::Receiver<HashMap<String, History>> {
        self.history.subscribe()
    }

    /// Opens a page on the web in the target's tab.
    pub async fn open(&self, target: &str, url: &str) -> anyhow::Result<()> {
        ensure_web(url)?;
        self.call(target, "Page.navigate", json!({ "url": url }))
            .await?;
        Ok(())
    }

    /// Opens a tab, on a page on the web or on none, and gives its page. The tab is shown
    /// `like` another where one is given: as on a phone from its first page on, where
    /// that one is.
    pub async fn open_tab(&self, url: &str, like: Option<Like>) -> anyhow::Result<String> {
        if !url.is_empty() {
            ensure_web(url)?;
        }
        let phone = like.is_some_and(|like| like.mobile);
        // A page asked for before the tab is shown as on a phone would be a desktop's:
        // the tab opens empty, and goes to its page once it is shown as it is to be.
        let first = match (url.is_empty(), phone) {
            (true, _) => NEW_TAB,
            (false, true) => "about:blank",
            (false, false) => url,
        };
        // The browser may tell of the tab before it answers with it.
        let opening = self.tabs.opening().await;
        let made = self
            .browser
            .call("Target.createTarget", json!({ "url": first }))
            .await?;
        let page = made["targetId"]
            .as_str()
            .context("the browser named no tab")?
            .to_owned();
        if let Some(like) = like {
            self.tabs.expect(page.clone(), like);
        }
        drop(opening);
        if first != url && !url.is_empty() {
            let (pages, page, url) = (self.clone(), page.clone(), url.to_owned());
            tokio::spawn(async move {
                let gone = pages.call(&page, "Page.navigate", json!({ "url": url }));
                if let Err(err) = gone.await {
                    warn!(
                        page,
                        "a tab that was opened did not go to its page: {err:#}"
                    );
                }
            });
        }
        Ok(page)
    }

    /// Takes note of which ways the history of a page goes now.
    async fn look_back(&self, target: &str, session: &str) {
        let told = self
            .browser
            .call_in(Some(session), "Page.getNavigationHistory", json!({}));
        // A page that is gone has no history to tell.
        let Ok(told) = told.await else {
            return;
        };
        let at = told["currentIndex"].as_u64().unwrap_or(0) as usize;
        let entries = told["entries"].as_array().map_or(0, Vec::len);
        let now = History {
            back: at > 0,
            forward: at + 1 < entries,
        };
        self.history
            .send_if_modified(|history| history.insert(target.to_owned(), now) != Some(now));
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
        let kind = picture_kind(&bytes).context("not a picture")?;
        Ok((kind, bytes))
    }

    /// The icon of the target's page, as the session's own browser fetches it: its bytes,
    /// and what kind of picture they are; none where the page has none, or its icon does
    /// not come. The page's site is asked by the session, as for anything else the page
    /// shows, and is told nothing of who watches. It fails where the page could not be
    /// asked, as one that is gone, or goes elsewhere while it is: that says nothing of
    /// the page there is after.
    pub async fn icon(&self, target: &str) -> anyhow::Result<Option<(&'static str, Vec<u8>)>> {
        let asked = json!({
            "expression": ICON_OF_PAGE,
            "returnByValue": true,
            "awaitPromise": true,
        });
        let named = self.call(target, "Runtime.evaluate", asked).await?;
        ensure!(
            named["exceptionDetails"].is_null(),
            "the page went elsewhere while it was asked"
        );
        let Some(url) = named["result"]["value"].as_str() else {
            return Ok(None);
        };
        Ok(self.fetched(target, url).await.ok())
    }

    /// The icon at an address, fetched as the target's page would fetch it.
    async fn fetched(&self, target: &str, url: &str) -> anyhow::Result<(&'static str, Vec<u8>)> {
        use base64::Engine;
        let decode = |text: &str| base64::engine::general_purpose::STANDARD.decode(text);
        let bytes = if let Some(told) = url.strip_prefix("data:") {
            let (how, data) = told.split_once(',').context("not an icon")?;
            match how.ends_with(";base64") {
                true => decode(data.trim())?,
                false => percent_encoding::percent_decode_str(data).collect(),
            }
        } else {
            let frames = self.call(target, "Page.getFrameTree", json!({})).await?;
            let frame = frames["frameTree"]["frame"]["id"]
                .as_str()
                .context("the page has no frame")?;
            let loaded = self
                .call(
                    target,
                    "Network.loadNetworkResource",
                    json!({
                        "frameId": frame,
                        "url": url,
                        "options": { "disableCache": false, "includeCredentials": true },
                    }),
                )
                .await?;
            let resource = &loaded["resource"];
            ensure!(resource["success"] == true, "the icon did not load");
            let stream = resource["stream"].as_str().context("the icon is empty")?;
            let mut bytes = Vec::new();
            let read = async {
                loop {
                    let part = self
                        .call(target, "IO.read", json!({ "handle": stream }))
                        .await?;
                    let data = part["data"].as_str().unwrap_or_default();
                    match part["base64Encoded"] == true {
                        true => bytes.extend(decode(data)?),
                        false => bytes.extend(data.as_bytes()),
                    }
                    ensure!(bytes.len() <= ICON_MOST, "the icon is too large");
                    if part["eof"] == true {
                        return Ok(());
                    }
                }
            };
            let read: anyhow::Result<()> = read.await;
            let closed = self.call(target, "IO.close", json!({ "handle": stream }));
            closed.await.ok();
            read?;
            bytes
        };
        let kind = picture_kind(&bytes).context("not an icon")?;
        Ok((kind, bytes))
    }
}

/// The largest icon that is taken from a page, in bytes.
const ICON_MOST: usize = 1024 * 1024;

/// Which icon a page names for itself: one that is drawn at any size, else one of a size a
/// list of tabs shows well, else the first, and where it names none, the one its site has
/// where sites have theirs. A page that is not of the web has none. A page that is still
/// read has not said all of its head: it is asked once it has, or after a while, as it
/// would name none until then and be taken for one whose site has its icon.
const ICON_OF_PAGE: &str = r#"(async () => {
  if (document.readyState === "loading") {
    await new Promise((read) => {
      addEventListener("DOMContentLoaded", read, { once: true });
      setTimeout(read, 5000);
    });
  }
  const links = [...document.querySelectorAll('link[rel~="icon" i][href]')];
  const sized = (link) => /(^|\s)(32x32|48x48|64x64|96x96)(\s|$)/u.test(link.getAttribute("sizes") ?? "");
  const link = links.find((one) => one.type === "image/svg+xml") ?? links.find(sized) ?? links[0];
  if (link !== undefined) {
    return /^(https?|data):/u.test(link.href) ? link.href : null;
  }
  return /^https?:$/u.test(location.protocol) ? new URL("/favicon.ico", location.origin).href : null;
})()"#;

/// What kind of picture the bytes are, where they are one a browser shows.
fn picture_kind(bytes: &[u8]) -> Option<&'static str> {
    Some(match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xff, 0xd8, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [0, 0, 1, 0, ..] => "image/x-icon",
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
        _ if String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).contains("<svg") => {
            "image/svg+xml"
        }
        _ => return None,
    })
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
    /// A phone's user agent of this browser's make, once it was asked what it is.
    agent: Option<String>,
    /// How each target's page is shown, and how many times it was told to load again.
    shown: HashMap<String, (Shown, u32)>,
    /// The script that tells a phone's platform, of each page that has it.
    says: HashMap<String, Option<String>>,
}

impl Follower {
    /// Attaches the pages that are new, and forgets what was of those that are gone.
    async fn keep(&mut self, targets: Vec<Target>) {
        let pages: Vec<String> = targets.iter().map(|target| target.id.clone()).collect();
        self.shown.retain(|target, _| pages.contains(target));
        self.says.retain(|target, _| pages.contains(target));
        for target in &targets {
            let session = {
                let attached = self.pages.attached.borrow();
                let found = attached.iter().find(|(page, _)| *page == target.id);
                found.map(|(_, session)| session.clone())
            };
            match session {
                Some(session) => self.show(target, &session, false).await,
                None => self.attach(target).await,
            }
        }
        let Pages { open, attached, .. } = &self.pages;
        attached.send_modify(|attached| {
            attached.retain(|(target, _)| pages.contains(target));
        });
        self.pages.history.send_if_modified(|history| {
            let before = history.len();
            history.retain(|target, _| pages.contains(target));
            history.len() != before
        });
        self.frames.retain(|(target, _)| pages.contains(target));
        open.send_if_modified(|open| {
            let before = open.len();
            open.retain(|asked| pages.contains(&asked.request.target));
            open.len() != before
        });
    }

    /// Attaches a page that is new, shown as its tab is before anything is asked of it.
    async fn attach(&mut self, target: &Target) {
        let page = &target.id;
        match attach(&self.pages.browser, page).await {
            Ok(session) => {
                self.show(target, &session, true).await;
                self.pages.look_back(page, &session).await;
                let attached = &self.pages.attached;
                attached.send_modify(|attached| attached.push((page.clone(), session)));
            }
            Err(err) => warn!(page, "a page asks the browser, not the session: {err:#}"),
        }
    }

    /// Has a target's page shown as its tab is, where it is not yet, and loads it again
    /// where it was told to. A page that is `new` here and came as a desktop's loads
    /// again too: a tab the browser brought back, or one a page opened.
    async fn show(&mut self, target: &Target, session: &str, new: bool) {
        let now = (Shown::of(target), target.loads);
        let before = self.shown.get(&target.id).copied();
        if before == Some(now) || (before.is_none() && !target.mobile) {
            self.shown.insert(target.id.clone(), now);
            return;
        }
        let browser = &self.pages.browser;
        if self.agent.is_none() {
            let told = browser.call("Browser.getVersion", json!({})).await;
            self.agent = told
                .ok()
                .and_then(|told| phone_agent(told["userAgent"].as_str()?));
        }
        let Some(agent) = &self.agent else {
            warn!("the browser does not say what it is: no page is shown as on a phone");
            return;
        };
        let says = self.says.entry(target.id.clone()).or_default();
        if before.map(|(shown, _)| shown) != Some(now.0)
            && let Err(err) = show(browser, session, agent, now.0, says).await
        {
            warn!(
                page = target.id,
                "a page is not shown as its tab is: {err:#}"
            );
            return;
        }
        // A phone's page that got shorter did so for a keyboard, as a rule: what is typed
        // into stays where it is seen, as a phone's browser keeps it.
        let shorter = before
            .is_some_and(|(shown, _)| shown.mobile && now.0.mobile && now.0.height < shown.height);
        if shorter {
            let reveal = json!({
                "expression": "document.activeElement?.matches?.('input, textarea, select, [contenteditable]') && document.activeElement.scrollIntoView({ block: 'center' })",
            });
            let revealed = browser.call_in(Some(session), "Runtime.evaluate", reveal);
            if let Err(err) = revealed.await {
                warn!(
                    page = target.id,
                    "what is typed into may be out of sight: {err:#}"
                );
            }
        }
        let again = match before {
            Some((_, loads)) => loads != now.1,
            None => new && target.url.starts_with("http"),
        };
        self.shown.insert(target.id.clone(), now);
        if again
            && let Err(err) = browser
                .call_in(Some(session), "Page.reload", json!({}))
                .await
        {
            warn!(page = target.id, "a page did not load again: {err:#}");
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
            // Of the page itself: a frame in it has a history of its own to nobody.
            // The history has the page it came to only a moment after it is said to have
            // come, so it is looked at again once the page has loaded.
            "Page.frameNavigated"
            | "Page.navigatedWithinDocument"
            | "Page.frameStoppedLoading"
            | "Page.loadEventFired" => {
                let page = self
                    .pages
                    .attached
                    .borrow()
                    .iter()
                    .any(|(_, of)| *of == session);
                if page {
                    self.pages.look_back(&target, &session).await;
                }
                // Another DevTools session attached to the page, as an automation's is,
                // has the document that comes say the platform the browser is on: it is
                // told again what a phone's says.
                let phone_shown = self
                    .shown
                    .get(&target)
                    .is_some_and(|(shown, _)| shown.mobile);
                let came = event.method == "Page.frameNavigated"
                    && event.params["frame"]["parentId"].is_null();
                if page
                    && came
                    && phone_shown
                    && let Some(agent) = &self.agent
                {
                    let browser = &self.pages.browser;
                    let told = browser.call_in(
                        Some(&session),
                        "Emulation.setUserAgentOverride",
                        phone(agent),
                    );
                    if let Err(err) = told.await {
                        warn!(page = target, "a page is not told it is a phone's: {err:#}");
                    }
                }
            }
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

fn ensure_web(url: &str) -> anyhow::Result<()> {
    let web = url::Url::parse(url).is_ok_and(|url| matches!(url.scheme(), "http" | "https"));
    anyhow::ensure!(web, "not a page on the web");
    Ok(())
}
