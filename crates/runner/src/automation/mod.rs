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

mod keys;
mod tab;
mod tools;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, bail};
use aperture_runner::{Access, Area};
use async_trait::async_trait;
use browse_core::{
    Browser, Cdp, HandoffResult, TabId, TabInfo, TabOptions, TabState, Tool, ToolContext,
    ToolOutput, ToolSpec,
};
use serde_json::{Value, json};
use tokio::{
    sync::watch,
    time::{Instant, sleep, timeout},
};
use tracing::warn;

use self::{
    tab::TabSession,
    tools::{RecordingTool, TabsTool},
};
use crate::{
    cdp,
    live::{edit::plan::Pace, record::Recordings},
    presence::{Identity, Membership, Presence},
    targets::Target,
};

const TAB_READY_WITHIN: Duration = Duration::from_secs(15);
const LOAD_WITHIN: Duration = Duration::from_secs(30);

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
        targets: watch::Receiver<Vec<Target>>,
        recordings: Recordings,
        files: PathBuf,
        presence: &Arc<Presence>,
    ) -> Self {
        let agent = Identity {
            subject: "agent".to_owned(),
            name: "Agent".to_owned(),
            // The automation gives input and asks for the tabs it wants, as a person does.
            access: Access::default().writing(Area::Input),
        };
        let session = Arc::new(Session {
            browser,
            targets,
            recordings: recordings.clone(),
            tabs: Mutex::default(),
            presence: presence.clone(),
            agent: Arc::new(presence.join(agent, true)),
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

    /// A scroll of the page to one of its edges, as a scroll by the distance there. To an
    /// edge, the page is put there in one step, which a recording at a pace would show as
    /// a jump; by a distance, the wheel turns in steps. None for a scroll that is to go as
    /// it is.
    async fn travel_to_edge(&self, arguments: &Value) -> Option<Value> {
        let edge = arguments["to"].as_str()?;
        let tab = arguments["tab"].as_i64()?;
        let within = ["ref", "selector"]
            .iter()
            .any(|key| !arguments[*key].is_null());
        let browser = &self.context.browser;
        if within || !browser.human_input(tab).await {
            return None;
        }
        // A page that cannot be measured is scrolled as asked, and says what is wrong
        // with it then.
        let measured = browser
            .cdp(tab)
            .await
            .ok()?
            .send(
                "Runtime.evaluate",
                json!({
                    "expression": "(() => { const e = document.scrollingElement; return [e.scrollLeft, e.scrollTop, e.scrollWidth - e.clientWidth, e.scrollHeight - e.clientHeight]; })()",
                    "returnByValue": true,
                }),
                None,
            )
            .await
            .ok()?;
        let at = |index: usize| measured["result"]["value"][index].as_f64();
        let (left, top, right, bottom) = (at(0)?, at(1)?, at(2)?, at(3)?);
        let (dx, dy) = match edge {
            "top" => (0.0, -top),
            "bottom" => (0.0, bottom - top),
            "left" => (-left, 0.0),
            "right" => (right - left, 0.0),
            _ => return None,
        };
        (dx.abs() >= 1.0 || dy.abs() >= 1.0)
            .then(|| json!({ "tab": tab, "deltaX": dx, "deltaY": dy }))
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
        if name == "scroll"
            && let Some(travel) = self.travel_to_edge(&arguments).await
        {
            // The page travels there first; the call itself then finds it there, and says
            // where that is.
            if let Err(err) = tool.call(self.context.clone(), travel).await {
                warn!("a scroll to an edge goes there in one step: {err:#}");
            }
        }
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
    targets: watch::Receiver<Vec<Target>>,
    recordings: Recordings,
    tabs: Mutex<Tabs>,
    presence: Arc<Presence>,
    /// The automation as one of those in the session: its input takes turns with theirs.
    agent: Arc<Membership>,
}

#[derive(Default)]
struct Tabs {
    by_id: HashMap<TabId, Tab>,
}

struct Tab {
    target: String,
    cdp: Option<Arc<TabSession>>,
    state: Arc<TabState>,
}

impl Session {
    /// The tab a target is, by the number the session gave it.
    fn tab_of(&self, target: &Target) -> TabId {
        let id = TabId::from(target.tab);
        let mut tabs = self.tabs.lock().expect("not poisoned");
        tabs.by_id.entry(id).or_insert_with(|| Tab {
            target: target.id.clone(),
            cdp: None,
            state: Arc::default(),
        });
        id
    }

    /// The target a tab is, while the target lasts.
    fn target_of(&self, tab: TabId) -> anyhow::Result<Target> {
        // A tab may be named by its number before anything listed it.
        let targets = self.targets.borrow().clone();
        for target in &targets {
            self.tab_of(target);
        }
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
            tab: self.tab_of(target),
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
        let opened = self
            .targets
            .borrow()
            .iter()
            .find(|target| target.id == id)
            .cloned();
        let tab = self.tab_of(&opened.context("the new tab closed")?);

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
            self.targets.clone(),
            self.recordings.clone(),
            target.id,
            self.presence.clone(),
            self.agent.clone(),
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
        let named = self
            .targets
            .borrow()
            .iter()
            .find(|target| target.id.eq_ignore_ascii_case(name))
            .cloned();
        let Some(named) = named else {
            bail!("no tab {name}; `tabs` lists the tabs there are");
        };
        Ok(self.tab_of(&named))
    }
}
