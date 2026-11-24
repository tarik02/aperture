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

mod files;
mod keys;
mod tab;
mod tools;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
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
    files::FilesTool,
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
/// A caller is in the session until they called nothing for this long: an agent thinks
/// between its calls, and is not gone meanwhile.
const CALLER_STAYS_FOR: Duration = Duration::from_secs(120);
const CALLERS_SETTLE_EVERY: Duration = Duration::from_secs(10);

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
    "files",
];

const INSTRUCTIONS: &str = "A browser session. Its pages are tabs: `tabs` lists them, \
    `navigate` without a `tab` opens one and returns its id, and every other tool takes \
    that `tab`. A tab is named by its number or by its DevTools target id. A tab shows its \
    pages as on a desktop or as on a phone, which `tabs` tells and sets. Read a page with \
    `snapshot`, which gives elements refs that `click`, `fill` and the other tools take, or \
    look at it with `screenshot`. `recording` films a tab into the session's files, which \
    `files` lists. People may be watching the session and using it too.";

/// The session's tools, and what they act on.
///
/// Whoever calls with the session's own token is the automation itself among the session's
/// members. A caller someone vouches for is a member of their own, under their name and
/// marked as automation: one for each of them, however many connections their calls come
/// over, since one connection carries the calls of many where the control plane sends
/// them on.
pub struct Automation {
    tools: Vec<Arc<dyn Tool>>,
    session: Arc<Session>,
    files: PathBuf,
    recordings: Recordings,
    callers: Arc<Mutex<HashMap<String, Calling>>>,
}

/// A caller as a member of the session.
struct Calling {
    name: String,
    member: Arc<Membership>,
    called: Instant,
}

impl Automation {
    pub fn new(
        browser: cdp::Client,
        targets: watch::Receiver<Vec<Target>>,
        shown: crate::targets::Tabs,
        recordings: Recordings,
        files: PathBuf,
        presence: &Arc<Presence>,
    ) -> Self {
        let session = Arc::new(Session {
            browser,
            targets: targets.clone(),
            recordings: recordings.clone(),
            tabs: Mutex::default(),
            presence: presence.clone(),
        });
        let mut tools: Vec<Arc<dyn Tool>> = vec![
            Arc::new(TabsTool {
                targets: targets.clone(),
                shown,
            }),
            Arc::new(RecordingTool(recordings.clone())),
            Arc::new(FilesTool(files.clone())),
        ];
        let theirs = browse_page::tools()
            .into_iter()
            .chain(browse_capture::tools())
            .filter(|tool| !LEFT_OUT.contains(&tool.spec().name.as_str()));
        tools.extend(theirs);
        tools.extend(browse_script::tools(&tools));

        let callers: Arc<Mutex<HashMap<String, Calling>>> = Arc::default();
        let settled = Arc::downgrade(&callers);
        tokio::spawn(settle(settled));
        Self {
            tools,
            session,
            files,
            recordings,
            callers,
        }
    }

    /// The member a call is made as: the automation itself for the operator, and for
    /// anyone else a member of their own. Either joins with their first call, and leaves
    /// once they have called nothing for a while: nobody is shown in a session that no
    /// automation uses.
    fn member(&self, caller: Option<&Identity>) -> Arc<Membership> {
        let itself = Identity {
            subject: "agent".to_owned(),
            name: "Agent".to_owned(),
            access: acting(),
        };
        let caller = caller
            .filter(|caller| !caller.is_operator())
            .unwrap_or(&itself);
        let mut callers = self.callers.lock().expect("not poisoned");
        let known = callers
            .get_mut(&caller.subject)
            .filter(|known| known.name == caller.name);
        if let Some(known) = known {
            known.called = Instant::now();
            return known.member.clone();
        }
        let identity = Identity {
            subject: caller.subject.clone(),
            name: caller.name.clone(),
            access: acting(),
        };
        let member = Arc::new(self.session.presence.join(identity, true));
        let calling = Calling {
            name: caller.name.clone(),
            member: member.clone(),
            called: Instant::now(),
        };
        // One who was here under another name leaves with it.
        callers.insert(caller.subject.clone(), calling);
        member
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
    async fn travel_to_edge(&self, browser: &Acting, arguments: &Value) -> Option<Value> {
        let edge = arguments["to"].as_str()?;
        let tab = arguments["tab"].as_i64()?;
        let within = ["ref", "selector"]
            .iter()
            .any(|key| !arguments[*key].is_null());
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

    /// Calls a tool as `caller`, or as the operator. What goes wrong comes back as the
    /// tool's result, where a model reads it.
    pub async fn call(
        &self,
        caller: Option<&Identity>,
        name: &str,
        mut arguments: Value,
    ) -> ToolOutput {
        let Some(tool) = self.tools.iter().find(|tool| tool.spec().name == name) else {
            return ToolOutput::error(format!("no tool named {name}"));
        };
        let browser = Arc::new(Acting {
            session: self.session.clone(),
            member: self.member(caller),
        });
        let context = ToolContext {
            browser: browser.clone(),
            file_roots: vec![self.files.clone()],
        };
        // Tools take a tab by its number; a target id names one too.
        if let Some(tab) = arguments.get("tab").filter(|tab| tab.is_string()) {
            match browser.resolve_tab(tab) {
                Ok(tab) => arguments["tab"] = tab.into(),
                Err(err) => return ToolOutput::error(format!("{err:#}")),
            }
        }
        let tab = arguments.get("tab").cloned();
        let acted_on = tab.as_ref().and_then(Value::as_u64);
        if let Some(tab) = acted_on.filter(|_| !READS_ONLY.contains(&name)) {
            self.recordings.follow(tab as u32).await;
        }
        let started = self.recordings.now();
        if name == "scroll"
            && let Some(travel) = self.travel_to_edge(&browser, &arguments).await
        {
            // The page travels there first; the call itself then finds it there, and says
            // where that is.
            if let Err(err) = tool.call(context.clone(), travel).await {
                warn!("a scroll to an edge goes there in one step: {err:#}");
            }
        }
        let output = match tool.call(context, arguments).await {
            Ok(output) => output,
            Err(err) => ToolOutput::error(format!("{err:#}")),
        };
        // A call that took long is no silence of its caller's.
        if let Some(caller) = caller
            && let Some(known) = self
                .callers
                .lock()
                .expect("not poisoned")
                .get_mut(&caller.subject)
        {
            known.called = Instant::now();
        }
        if !READS_ONLY.contains(&name) {
            let fields = json!({ "tool": name, "ok": !output.is_error, "tab": tab });
            self.recordings.note(None, "call", started, fields);
        }
        output
    }
}

/// What the automation may do among the session's members, whoever it acts for: give
/// input and ask for the tabs it wants, as a person does.
fn acting() -> Access {
    Access::default().writing(Area::Input)
}

/// Lets the callers that called nothing for a while leave the session, for as long as
/// there is an automation they call.
async fn settle(callers: Weak<Mutex<HashMap<String, Calling>>>) {
    loop {
        sleep(CALLERS_SETTLE_EVERY).await;
        let Some(callers) = callers.upgrade() else {
            return;
        };
        let now = Instant::now();
        callers.lock().expect("not poisoned").retain(|_, calling| {
            // A call that is still made holds the member too.
            Arc::strong_count(&calling.member) > 1 || now - calling.called < CALLER_STAYS_FOR
        });
    }
}

struct Session {
    browser: cdp::Client,
    targets: watch::Receiver<Vec<Target>>,
    recordings: Recordings,
    tabs: Mutex<Tabs>,
    presence: Arc<Presence>,
}

/// The session as one of the automation's callers has it: what they do in a tab is theirs
/// among the session's members.
struct Acting {
    session: Arc<Session>,
    member: Arc<Membership>,
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

    /// The tab's DevTools session: the same one for as long as it lasts and whoever acts
    /// in the tab, as the page tools keep what they know of the page with it.
    async fn attached(&self, tab: TabId) -> anyhow::Result<Arc<TabSession>> {
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
        )
        .await?;
        if let Some(tab) = self.tabs.lock().expect("not poisoned").by_id.get_mut(&tab) {
            tab.cdp = Some(session.clone());
        }
        Ok(session)
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

    async fn cdp(&self, tab: TabId) -> anyhow::Result<Arc<dyn Cdp>> {
        Ok(self.attached(tab).await?)
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

#[async_trait]
impl Browser for Acting {
    async fn open_tab(&self, url: Option<&str>, options: &TabOptions) -> anyhow::Result<TabInfo> {
        self.session.open_tab(url, options).await
    }

    async fn tabs(&self) -> anyhow::Result<Vec<TabInfo>> {
        self.session.tabs().await
    }

    async fn close_tab(&self, tab: TabId) -> anyhow::Result<()> {
        self.session.close_tab(tab).await
    }

    /// The tab's one DevTools session, which whoever asks for it acts in from then on: a
    /// tool asks for it before it does anything in the tab. Two who call tools on one tab
    /// at once are told apart no further than that, and get in each other's way anyhow.
    async fn cdp(&self, tab: TabId) -> anyhow::Result<Arc<dyn Cdp>> {
        let attached = self.session.attached(tab).await?;
        attached.acts_as(self.member.id);
        Ok(attached)
    }

    async fn state(&self, tab: TabId) -> anyhow::Result<Arc<TabState>> {
        self.session.state(tab).await
    }

    async fn handoff(&self, tab: TabId, message: &str) -> anyhow::Result<HandoffResult> {
        self.session.handoff(tab, message).await
    }

    async fn human_input(&self, tab: TabId) -> bool {
        self.session.human_input(tab).await
    }

    async fn read_only(&self, tab: TabId) -> bool {
        self.session.read_only(tab).await
    }

    fn resolve_tab(&self, value: &Value) -> anyhow::Result<TabId> {
        self.session.resolve_tab(value)
    }
}
