//! Automation of the session's browser: the page, capture and script tools of `browse`, on
//! the session's targets.
//!
//! `browse` drives a tab through its DevTools session and asks for little else: a tab to
//! open, the tabs there are, and a place to keep state per tab. Its tabs are the session's
//! targets here, numbered as they are first named.
//!
//! Pointer and key input does not go to the page through DevTools, which would move nothing
//! anyone watches: it is given to the compositor as input to the target's window, so the
//! browser gets it as it gets a person's, and those who watch see it happen.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, bail};
use aperture_compositor::{Button, Handle, Input, WindowId};
use async_trait::async_trait;
use browse_core::{
    Browser, Cdp, CdpError, CdpEvent, HandoffResult, TabId, TabInfo, TabOptions, TabState, Tool,
    ToolContext, ToolOutput, ToolSpec,
};
use serde_json::{Value, json};
use tokio::{
    sync::{broadcast, watch},
    time::{Instant, sleep, timeout},
};

use crate::{
    cdp,
    live::{
        edit::plan::Pace,
        record::{Place, Recordings, Subject},
    },
    targets::Target,
};

const TAB_READY_WITHIN: Duration = Duration::from_secs(15);
const LOAD_WITHIN: Duration = Duration::from_secs(30);
/// How long the page gets to take in input the compositor delivered, before the command
/// that caused it counts as done.
const INPUT_SETTLES_WITHIN: Duration = Duration::from_millis(500);
/// What a slow pace adds to each step of the pointer's travel.
const SLOW_STEP: Duration = Duration::from_millis(14);

/// `browse`'s recorder films the page through DevTools; the session records its targets
/// itself, under the same name.
const LEFT_OUT: &[&str] = &["recording"];

/// Tools that change nothing on a page, which a recording's journal leaves out.
const READS_ONLY: &[&str] = &[
    "tabs",
    "snapshot",
    "screenshot",
    "screenshot_diff",
    "console",
    "network",
    "wait_for",
    "recording",
];

const INSTRUCTIONS: &str = "A browser session. Its pages are tabs: `tabs` lists them, \
    `navigate` without a `tab` opens one and returns its id, and every other tool takes \
    that `tab`. A tab is named by its number or by its DevTools target id. Read a page with \
    `snapshot`, which gives elements refs that `click`, `fill` and the other tools take, or \
    look at it with `screenshot`. People may be watching the session and using it too.";

/// The session's tools, and what they act on.
pub struct Automation {
    tools: Vec<Arc<dyn Tool>>,
    context: ToolContext,
    recordings: Recordings,
}

impl Automation {
    pub fn new(
        browser: cdp::Client,
        compositor: Handle,
        targets: watch::Receiver<Vec<Target>>,
        recordings: Recordings,
        files: PathBuf,
    ) -> Self {
        let session = Arc::new(Session {
            browser,
            compositor,
            targets,
            recordings: recordings.clone(),
            tabs: Mutex::default(),
        });
        let mut tools: Vec<Arc<dyn Tool>> = vec![
            Arc::new(TabsTool),
            Arc::new(RecordingTool(recordings.clone())),
        ];
        let theirs = browse_page::tools()
            .into_iter()
            .chain(browse_capture::tools())
            .filter(|tool| !LEFT_OUT.contains(&tool.spec().name.as_str()));
        tools.extend(theirs);
        tools.extend(browse_script::tools(&tools));
        Self {
            tools,
            context: ToolContext {
                browser: session,
                file_roots: vec![files],
            },
            recordings,
        }
    }

    pub fn instructions(&self) -> &'static str {
        INSTRUCTIONS
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        self.tools.iter().map(|tool| tool.spec()).collect()
    }

    /// Calls a tool. What goes wrong comes back as the tool's result, where a model reads
    /// it.
    pub async fn call(&self, name: &str, mut arguments: Value) -> ToolOutput {
        let Some(tool) = self.tools.iter().find(|tool| tool.spec().name == name) else {
            return ToolOutput::error(format!("no tool named {name}"));
        };
        // Tools take a tab by its number; a target id names one too.
        if let Some(tab) = arguments.get("tab").filter(|tab| tab.is_string()) {
            match self.context.browser.resolve_tab(tab) {
                Ok(tab) => arguments["tab"] = tab.into(),
                Err(err) => return ToolOutput::error(format!("{err:#}")),
            }
        }
        let started = self.recordings.now();
        let tab = arguments.get("tab").cloned();
        let output = match tool.call(self.context.clone(), arguments).await {
            Ok(output) => output,
            Err(err) => ToolOutput::error(format!("{err:#}")),
        };
        if !READS_ONLY.contains(&name) {
            let fields = json!({ "tool": name, "ok": !output.is_error, "tab": tab });
            self.recordings.note(None, "call", started, fields);
        }
        output
    }
}

struct Session {
    browser: cdp::Client,
    compositor: Handle,
    targets: watch::Receiver<Vec<Target>>,
    recordings: Recordings,
    tabs: Mutex<Tabs>,
}

#[derive(Default)]
struct Tabs {
    by_target: HashMap<String, TabId>,
    by_id: HashMap<TabId, Tab>,
    last: TabId,
}

struct Tab {
    target: String,
    cdp: Option<Arc<TabSession>>,
    state: Arc<TabState>,
}

impl Session {
    /// The tab a target is, numbered the first time it is asked for.
    fn tab_of(&self, target: &str) -> TabId {
        let mut tabs = self.tabs.lock().expect("not poisoned");
        if let Some(tab) = tabs.by_target.get(target) {
            return *tab;
        }
        tabs.last += 1;
        let id = tabs.last;
        tabs.by_target.insert(target.to_owned(), id);
        tabs.by_id.insert(
            id,
            Tab {
                target: target.to_owned(),
                cdp: None,
                state: Arc::default(),
            },
        );
        id
    }

    /// The target a tab is, while the target lasts.
    fn target_of(&self, tab: TabId) -> anyhow::Result<Target> {
        let id = self
            .tabs
            .lock()
            .expect("not poisoned")
            .by_id
            .get(&tab)
            .map(|tab| tab.target.clone())
            .with_context(|| format!("no tab {tab}; `tabs` lists the tabs there are"))?;
        self.targets
            .borrow()
            .iter()
            .find(|target| target.id == id)
            .cloned()
            .with_context(|| format!("tab {tab} is closed"))
    }

    fn info(&self, target: &Target) -> TabInfo {
        TabInfo {
            tab: self.tab_of(&target.id),
            url: target.url.clone(),
            title: target.title.clone(),
            lent: false,
            // The target id, which the session's other interfaces name a page by.
            chosen: Some(target.id.clone()),
            opener: None,
            last_used: None,
            busy: false,
            options: TabOptions::default(),
        }
    }
}

#[async_trait]
impl Browser for Session {
    async fn open_tab(&self, url: Option<&str>, _options: &TabOptions) -> anyhow::Result<TabInfo> {
        let created = self
            .browser
            .call(
                "Target.createTarget",
                json!({ "url": url.unwrap_or("about:blank") }),
            )
            .await?;
        let id = created["targetId"]
            .as_str()
            .context("the browser opened no tab")?
            .to_owned();

        // The page is a target once the extension gave it a window of its own.
        let mut targets = self.targets.clone();
        let ready = async {
            loop {
                if targets
                    .borrow_and_update()
                    .iter()
                    .any(|target| target.id == id)
                {
                    return;
                }
                if targets.changed().await.is_err() {
                    return;
                }
            }
        };
        timeout(TAB_READY_WITHIN, ready)
            .await
            .context("the new tab did not get a window of its own")?;
        let tab = self.tab_of(&id);

        let cdp = self.cdp(tab).await?;
        let deadline = Instant::now() + LOAD_WITHIN;
        loop {
            let state = cdp
                .send(
                    "Runtime.evaluate",
                    json!({ "expression": "document.readyState", "returnByValue": true }),
                    None,
                )
                .await;
            let loaded = state.is_ok_and(|state| state["result"]["value"] == "complete");
            if loaded || Instant::now() >= deadline {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
        self.target_of(tab).map(|target| self.info(&target))
    }

    async fn tabs(&self) -> anyhow::Result<Vec<TabInfo>> {
        let targets = self.targets.borrow().clone();
        Ok(targets.iter().map(|target| self.info(target)).collect())
    }

    async fn close_tab(&self, tab: TabId) -> anyhow::Result<()> {
        let target = self.target_of(tab)?;
        self.browser
            .call("Target.closeTarget", json!({ "targetId": target.id }))
            .await?;
        Ok(())
    }

    /// The tab's DevTools session: the same one for as long as it lasts, as the page tools
    /// keep what they know of the page with it.
    async fn cdp(&self, tab: TabId) -> anyhow::Result<Arc<dyn Cdp>> {
        let target = self.target_of(tab)?;
        let attached = self
            .tabs
            .lock()
            .expect("not poisoned")
            .by_id
            .get(&tab)
            .and_then(|tab| tab.cdp.clone())
            .filter(|session| session.is_attached());
        if let Some(session) = attached {
            return Ok(session);
        }
        let session = TabSession::attach(
            self.browser.clone(),
            self.compositor.clone(),
            self.targets.clone(),
            self.recordings.clone(),
            target.id,
        )
        .await?;
        if let Some(tab) = self.tabs.lock().expect("not poisoned").by_id.get_mut(&tab) {
            tab.cdp = Some(session.clone());
        }
        Ok(session)
    }

    async fn state(&self, tab: TabId) -> anyhow::Result<Arc<TabState>> {
        self.tabs
            .lock()
            .expect("not poisoned")
            .by_id
            .get(&tab)
            .map(|tab| tab.state.clone())
            .with_context(|| format!("no tab {tab}"))
    }

    async fn handoff(&self, _tab: TabId, _message: &str) -> anyhow::Result<HandoffResult> {
        bail!("this session cannot hand a tab to a person yet")
    }

    /// Input goes at once, unless the tab is being recorded at a pace: the pointer then
    /// travels to where it acts, along a path the eye can follow.
    async fn human_input(&self, tab: TabId) -> bool {
        self.target_of(tab)
            .ok()
            .and_then(|target| self.recordings.pace(&target.id))
            .is_some_and(|pace| pace != Pace::Instant)
    }

    async fn read_only(&self, _tab: TabId) -> bool {
        false
    }

    fn resolve_tab(&self, value: &Value) -> anyhow::Result<TabId> {
        if let Some(tab) = value.as_i64() {
            return Ok(tab);
        }
        let name = value
            .as_str()
            .context("tab must be a tab's number or its target id")?;
        if let Ok(tab) = name.parse() {
            return Ok(tab);
        }
        let known = self
            .targets
            .borrow()
            .iter()
            .any(|target| target.id.eq_ignore_ascii_case(name));
        if !known {
            bail!("no tab {name}; `tabs` lists the tabs there are");
        }
        Ok(self.tab_of(&name.to_ascii_uppercase()))
    }
}

/// A tab's DevTools session, attached through the browser's connection.
struct TabSession {
    browser: cdp::Client,
    compositor: Handle,
    targets: watch::Receiver<Vec<Target>>,
    recordings: Recordings,
    target: String,
    session: String,
    /// Where the tab's events go; none once the session ended, which closes the streams of
    /// those who listen.
    events: Mutex<Option<broadcast::Sender<CdpEvent>>>,
}

impl TabSession {
    async fn attach(
        browser: cdp::Client,
        compositor: Handle,
        targets: watch::Receiver<Vec<Target>>,
        recordings: Recordings,
        target: String,
    ) -> anyhow::Result<Arc<Self>> {
        // Before attaching, so no event of the session is missed.
        let mut browser_events = browser.events();
        let attached = browser
            .call(
                "Target.attachToTarget",
                json!({ "targetId": target, "flatten": true }),
            )
            .await?;
        let session = attached["sessionId"]
            .as_str()
            .context("the browser attached no session")?
            .to_owned();
        let (events, _) = broadcast::channel(1024);
        let attached = Arc::new(Self {
            browser,
            compositor,
            targets,
            recordings,
            target,
            session,
            events: Mutex::new(Some(events.clone())),
        });

        // Events of the tab's session are the tab's own; those of the sessions attached
        // below it, such as out-of-process frames, are passed on under their session id.
        let tab = Arc::downgrade(&attached);
        let own = attached.session.clone();
        tokio::spawn(async move {
            let mut children: HashSet<String> = HashSet::new();
            loop {
                let event = match browser_events.recv().await {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                let about = event.params["sessionId"].as_str();
                let session_id = match &event.session {
                    Some(session) if *session == own => None,
                    Some(session) if children.contains(session) => Some(session.clone()),
                    // The browser says the tab's session ended.
                    None if event.method == "Target.detachedFromTarget" && about == Some(&own) => {
                        break;
                    }
                    _ => continue,
                };
                match (event.method.as_str(), about) {
                    ("Target.attachedToTarget", Some(child)) => {
                        children.insert(child.to_owned());
                    }
                    ("Target.detachedFromTarget", Some(child)) => {
                        children.remove(child);
                    }
                    _ => {}
                }
                let _ = events.send(CdpEvent {
                    method: event.method,
                    params: event.params,
                    session_id,
                });
            }
            if let Some(tab) = tab.upgrade() {
                tab.events.lock().expect("not poisoned").take();
            }
        });
        Ok(attached)
    }

    fn is_attached(&self) -> bool {
        self.events.lock().expect("not poisoned").is_some()
    }

    /// The window that shows the tab now.
    fn window(&self) -> Option<WindowId> {
        self.targets
            .borrow()
            .iter()
            .find(|target| target.id == self.target)
            .map(|target| target.window)
    }

    /// Gives pointer and key commands to the compositor instead of the page. `None` for
    /// what the compositor has no input for, which goes to the page as it is.
    async fn deliver(&self, method: &str, params: &Value) -> Option<()> {
        let window = self.window()?;
        let (input, settles) = match (method, params["type"].as_str()?) {
            ("Input.dispatchMouseEvent", "mouseMoved") => (
                Input::PointerMotion {
                    window,
                    x: params["x"].as_f64()?,
                    y: params["y"].as_f64()?,
                },
                false,
            ),
            ("Input.dispatchMouseEvent", kind @ ("mousePressed" | "mouseReleased")) => (
                Input::PointerButton {
                    window,
                    x: params["x"].as_f64()?,
                    y: params["y"].as_f64()?,
                    button: match params["button"].as_str()? {
                        "left" => Button::Left,
                        "right" => Button::Right,
                        "middle" => Button::Middle,
                        "back" => Button::Back,
                        "forward" => Button::Forward,
                        _ => return None,
                    },
                    pressed: kind == "mousePressed",
                },
                true,
            ),
            ("Input.dispatchKeyEvent", kind @ ("keyDown" | "rawKeyDown" | "keyUp")) => (
                Input::Key {
                    window,
                    code: evdev_code(params["code"].as_str()?)?,
                    pressed: kind != "keyUp",
                },
                true,
            ),
            _ => return None,
        };
        // What the pointer did goes into the journals of the target's recordings.
        let now = self.recordings.now();
        match &input {
            Input::PointerMotion { x, y, .. } => {
                let fields = json!({ "x": x, "y": y });
                self.recordings
                    .note(Some(&self.target), "move", now, fields);
            }
            Input::PointerButton {
                x,
                y,
                pressed: true,
                ..
            } => {
                let fields = json!({
                    "x": x,
                    "y": y,
                    "button": params["button"],
                    "count": params["clickCount"].as_u64().unwrap_or(1),
                });
                self.recordings
                    .note(Some(&self.target), "press", now, fields);
            }
            _ => {}
        }
        let travelled = matches!(input, Input::PointerMotion { .. });
        self.compositor.input(input);
        // A slow pace takes each step of the pointer's way about twice as long.
        if travelled && self.recordings.pace(&self.target) == Some(Pace::Slow) {
            sleep(SLOW_STEP).await;
        }
        if settles {
            // The command is done once the page has seen the input, which reaches it by
            // another way than the commands do: a frame later, it has.
            let frame = self.browser.call_in(
                Some(&self.session),
                "Runtime.evaluate",
                json!({
                    "expression": "new Promise((done) => requestAnimationFrame(() => setTimeout(done)))",
                    "awaitPromise": true,
                }),
            );
            let _ = timeout(INPUT_SETTLES_WITHIN, frame).await;
        }
        Some(())
    }
}

#[async_trait]
impl Cdp for TabSession {
    async fn send(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value, CdpError> {
        let input = matches!(
            method,
            "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent"
        );
        if input && session_id.is_none() && self.deliver(method, &params).await.is_some() {
            return Ok(json!({}));
        }
        if method == "Input.dispatchMouseEvent" && params["type"] == "mouseWheel" {
            let fields = json!({
                "x": params["x"],
                "y": params["y"],
                "dx": params["deltaX"],
                "dy": params["deltaY"],
            });
            let now = self.recordings.now();
            self.recordings
                .note(Some(&self.target), "wheel", now, fields);
        }
        self.browser
            .call_in(Some(session_id.unwrap_or(&self.session)), method, params)
            .await
            .map_err(|err| match err {
                cdp::Error::Refused(message) => CdpError::Protocol(message),
                cdp::Error::Gone => CdpError::Disconnected,
            })
    }

    fn events(&self) -> broadcast::Receiver<CdpEvent> {
        match &*self.events.lock().expect("not poisoned") {
            Some(events) => events.subscribe(),
            // Closed from the start.
            None => broadcast::channel(1).1,
        }
    }
}

/// The Linux evdev code of a key named as DOM's `KeyboardEvent.code` names it.
fn evdev_code(code: &str) -> Option<u32> {
    const KEYS: &[(&str, u32)] = &[
        ("Escape", 1),
        ("Digit1", 2),
        ("Digit2", 3),
        ("Digit3", 4),
        ("Digit4", 5),
        ("Digit5", 6),
        ("Digit6", 7),
        ("Digit7", 8),
        ("Digit8", 9),
        ("Digit9", 10),
        ("Digit0", 11),
        ("Minus", 12),
        ("Equal", 13),
        ("Backspace", 14),
        ("Tab", 15),
        ("KeyQ", 16),
        ("KeyW", 17),
        ("KeyE", 18),
        ("KeyR", 19),
        ("KeyT", 20),
        ("KeyY", 21),
        ("KeyU", 22),
        ("KeyI", 23),
        ("KeyO", 24),
        ("KeyP", 25),
        ("BracketLeft", 26),
        ("BracketRight", 27),
        ("Enter", 28),
        ("ControlLeft", 29),
        ("KeyA", 30),
        ("KeyS", 31),
        ("KeyD", 32),
        ("KeyF", 33),
        ("KeyG", 34),
        ("KeyH", 35),
        ("KeyJ", 36),
        ("KeyK", 37),
        ("KeyL", 38),
        ("Semicolon", 39),
        ("Quote", 40),
        ("Backquote", 41),
        ("ShiftLeft", 42),
        ("Backslash", 43),
        ("KeyZ", 44),
        ("KeyX", 45),
        ("KeyC", 46),
        ("KeyV", 47),
        ("KeyB", 48),
        ("KeyN", 49),
        ("KeyM", 50),
        ("Comma", 51),
        ("Period", 52),
        ("Slash", 53),
        ("ShiftRight", 54),
        ("NumpadMultiply", 55),
        ("AltLeft", 56),
        ("Space", 57),
        ("CapsLock", 58),
        ("F1", 59),
        ("F2", 60),
        ("F3", 61),
        ("F4", 62),
        ("F5", 63),
        ("F6", 64),
        ("F7", 65),
        ("F8", 66),
        ("F9", 67),
        ("F10", 68),
        ("NumLock", 69),
        ("ScrollLock", 70),
        ("Numpad7", 71),
        ("Numpad8", 72),
        ("Numpad9", 73),
        ("NumpadSubtract", 74),
        ("Numpad4", 75),
        ("Numpad5", 76),
        ("Numpad6", 77),
        ("NumpadAdd", 78),
        ("Numpad1", 79),
        ("Numpad2", 80),
        ("Numpad3", 81),
        ("Numpad0", 82),
        ("NumpadDecimal", 83),
        ("IntlBackslash", 86),
        ("F11", 87),
        ("F12", 88),
        ("NumpadEnter", 96),
        ("ControlRight", 97),
        ("NumpadDivide", 98),
        ("AltRight", 100),
        ("Home", 102),
        ("ArrowUp", 103),
        ("PageUp", 104),
        ("ArrowLeft", 105),
        ("ArrowRight", 106),
        ("End", 107),
        ("ArrowDown", 108),
        ("PageDown", 109),
        ("Insert", 110),
        ("Delete", 111),
        ("MetaLeft", 125),
        ("MetaRight", 126),
        ("ContextMenu", 127),
    ];
    KEYS.iter()
        .find(|(name, _)| *name == code)
        .map(|(_, evdev)| *evdev)
}

/// The session's tabs: which there are, opening one, closing one.
struct TabsTool;

#[async_trait]
impl Tool for TabsTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "tabs".into(),
            description: "The session's tabs. `list` (the default) gives each tab's number, \
                DevTools target id, url and title; `new` opens one, at `url` when given, and \
                returns it; `close` closes `tab`."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "new", "close"] },
                    "url": { "type": "string", "description": "new: the page to open." },
                    "tab": {
                        "type": ["integer", "string"],
                        "description": "close: the tab's number or target id.",
                    },
                },
            }),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let targets = |tabs: Vec<TabInfo>| {
            let listed: Vec<Value> = tabs
                .into_iter()
                .map(|tab| {
                    json!({ "tab": tab.tab, "target": tab.chosen, "url": tab.url, "title": tab.title })
                })
                .collect();
            ToolOutput::text(Value::from(listed).to_string())
        };
        match args["action"].as_str().unwrap_or("list") {
            "list" => Ok(targets(ctx.browser.tabs().await?)),
            "new" => {
                let options = TabOptions::default();
                let tab = ctx.browser.open_tab(args["url"].as_str(), &options).await?;
                Ok(targets(vec![tab]))
            }
            "close" => {
                let tab = browse_core::require_tab(&args)?;
                ctx.browser.close_tab(tab).await?;
                Ok(ToolOutput::text(format!("closed tab {tab}")))
            }
            other => bail!("unknown action {other}; use list, new or close"),
        }
    }
}

/// Recordings of a tab, as files of the session, and what their edits show.
struct RecordingTool(Recordings);

#[async_trait]
impl Tool for RecordingTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "recording".into(),
            description: "Record a tab to a video file of the session, and say what the edited \
                video shows. `start` records `tab` (the newest tab when left out) from now on, \
                with the pointer in the picture, and returns the recording's `id`; `capture`, \
                `idle`, `ripple` and `burst` say how the edit is cut. While it runs: `caption` \
                shows `text`; `focus` zooms on a `rect`, a `selector`'s element or the \
                `pointer` until `reset_focus`; `attention` circles the pointer around `x`,`y` \
                or a `selector`. `stop` ends recording `id` and returns its raw video and \
                journal at once; the edit is made after, and `status` tells when its `edit` is \
                `finished` and where the edited video is. `list` gives every recording. \
                Annotations name the recording by `id` when several run."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "start", "caption", "focus", "reset_focus", "attention", "stop",
                            "status", "list",
                        ],
                    },
                    "tab": {
                        "type": ["integer", "string"],
                        "description": "start: the tab's number or target id.",
                    },
                    "id": { "type": "string", "description": "The recording's id." },
                    "capture": {
                        "type": "string",
                        "enum": ["continuous", "bursts"],
                        "description": "start: continuous (default), or bursts, which keeps only the stretches around what you do.",
                    },
                    "idle": {
                        "type": "string",
                        "enum": ["cut", "speed"],
                        "description": "start: remove, or fast-forward, the stretches in which nothing happens. Continuous capture only.",
                    },
                    "ripple": { "type": "boolean", "description": "start: mark clicks with a ripple." },
                    "pace": {
                        "type": "string",
                        "enum": ["instant", "fast", "slow"],
                        "description": "start: how your pointer moves while recording: instant (it jumps to each action), fast (default; quick travel the eye can follow) or slow (unhurried, for demos).",
                    },
                    "burst": {
                        "type": "object",
                        "description": "start: burst sizes in ms: lead_ms, tail_ms, settle_ms, max_tail_ms.",
                    },
                    "text": { "type": "string", "description": "caption: the text, up to 200 characters." },
                    "duration_ms": {
                        "type": "integer",
                        "description": "caption: how long it shows (default 3000). focus: zoom out after this long, and wait for it. attention: how long the pointer circles (default 1200).",
                    },
                    "rect": {
                        "type": "object",
                        "description": "focus: a fixed area of the viewport, {x, y, width, height} in CSS px.",
                    },
                    "selector": {
                        "type": "string",
                        "description": "focus, attention: a CSS selector of an element in the top document.",
                    },
                    "pointer": { "type": "boolean", "description": "focus: follow the pointer." },
                    "zoom": { "type": "number", "description": "focus: the zoom factor, above 1 and at most 4." },
                    "x": { "type": "number", "description": "attention: where, in CSS px." },
                    "y": { "type": "number", "description": "attention: where, in CSS px." },
                    "radius": { "type": "number", "description": "attention: the circle's radius in px (default 40)." },
                    "loops": { "type": "integer", "description": "attention: how many times the pointer circles (default 2)." },
                },
                "required": ["action"],
            }),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let id = args["id"].as_str();
        let duration_ms = args["duration_ms"].as_u64();
        let selector = args["selector"].as_str().map(str::to_owned);
        match args["action"].as_str().unwrap_or_default() {
            "start" => {
                let target = match args.get("tab").filter(|tab| !tab.is_null()) {
                    Some(tab) => {
                        let tab = ctx.browser.resolve_tab(tab)?;
                        let tabs = ctx.browser.tabs().await?;
                        let named = tabs.into_iter().find(|listed| listed.tab == tab);
                        Some(named.and_then(|tab| tab.chosen).context("no such tab")?)
                    }
                    None => None,
                };
                let mut options = serde_json::Map::new();
                for key in ["capture", "idle", "ripple", "burst", "pace"] {
                    if let Some(value) = args.get(key).filter(|value| !value.is_null()) {
                        options.insert(key.to_owned(), value.clone());
                    }
                }
                let options = serde_json::from_value(options.into())
                    .context("invalid capture, idle, ripple, burst or pace")?;
                Ok(shown(&self.0.start(target.as_deref(), options).await?))
            }
            "caption" => {
                let text = args["text"].as_str().context("pass the caption's `text`")?;
                self.0.caption(id, text, duration_ms)?;
                Ok(ToolOutput::text("captioned"))
            }
            "focus" => {
                let rect = args.get("rect").filter(|rect| !rect.is_null());
                let pointer = args["pointer"].as_bool().unwrap_or(false);
                let subject = match (rect, selector, pointer) {
                    (Some(rect), None, false) => Subject::Rect(
                        serde_json::from_value(rect.clone()).context("rect needs x and y")?,
                    ),
                    (None, Some(selector), false) => Subject::Selector(selector),
                    (None, None, true) => Subject::Pointer,
                    _ => bail!("pass exactly one of `rect`, `selector` and `pointer`"),
                };
                let zoom = args["zoom"].as_f64().context("pass the `zoom` factor")?;
                self.0.focus(id, subject, zoom, duration_ms).await?;
                Ok(ToolOutput::text("focused"))
            }
            "reset_focus" => {
                self.0.reset_focus(id)?;
                Ok(ToolOutput::text("zoomed out"))
            }
            "attention" => {
                let point = args["x"].as_f64().zip(args["y"].as_f64());
                let place = match (point, selector) {
                    (Some((x, y)), None) => Place::Point { x, y },
                    (None, Some(selector)) => Place::Selector(selector),
                    _ => bail!("pass `x` and `y`, or a `selector`, not both"),
                };
                let (radius, loops) = (args["radius"].as_f64(), args["loops"].as_u64());
                self.0
                    .attention(id, place, radius, loops, duration_ms)
                    .await?;
                Ok(ToolOutput::text("done"))
            }
            "stop" => {
                let id = id.context("pass the recording's `id`")?;
                Ok(shown(&self.0.stop(id).await?))
            }
            "status" => {
                let id = id.context("pass the recording's `id`")?;
                Ok(shown(&self.0.get(id)?))
            }
            "list" => Ok(shown(&self.0.list())),
            other => bail!("unknown action {other:?}"),
        }
    }
}

/// A value as a tool shows it: JSON.
fn shown(value: &impl serde::Serialize) -> ToolOutput {
    ToolOutput::text(serde_json::to_string_pretty(value).unwrap_or_default())
}
