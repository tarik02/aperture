//! The tools that are the session's own: its tabs, and its recordings.

use anyhow::{Context, bail};
use async_trait::async_trait;
use browse_core::{TabInfo, TabOptions, Tool, ToolContext, ToolOutput, ToolSpec};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    live::record::Recordings,
    pace::{Pace, Paced},
    targets::{self, Mode, Target},
};

/// The session's tabs: which there are, opening one, closing one, and how one is shown.
pub(super) struct TabsTool {
    pub targets: tokio::sync::watch::Receiver<Vec<Target>>,
    pub shown: targets::Tabs,
}

#[async_trait]
impl Tool for TabsTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "tabs".into(),
            description: "The session's tabs. `list` (the default) gives each tab's number, \
                DevTools target id, url, title, viewport, and how its pages are shown: its \
                `mode` (`auto`, `desktop` or `mobile`) and whether that is `mobile` now. \
                `new` opens one, at `url` when given, and returns it; `close` closes `tab`. \
                `mode` sets `tab`'s `mode`: `mobile` shows its pages as on a phone (a phone's \
                user agent and client hints, touch, a phone's viewport), `desktop` as on a \
                desktop, and either stays until it is set again. With `auto`, the default, \
                the tab is shown as on whatever device the person who last took it over \
                uses, and nothing changes while people only watch: set `desktop` or \
                `mobile` for a tab that has to stay one. The page loads again when its tab \
                comes to be shown another way, unless `reload` is false."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "new", "close", "mode"] },
                    "url": { "type": "string", "description": "new: the page to open." },
                    "tab": {
                        "type": ["integer", "string"],
                        "description": "close, mode: the tab's number or target id.",
                    },
                    "mode": { "type": "string", "enum": ["auto", "desktop", "mobile"] },
                    "reload": { "type": "boolean", "description": "mode: load the page again (default true)." },
                },
            }),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let targets = |tabs: Vec<TabInfo>| {
            let shown = self.targets.borrow();
            let listed: Vec<Value> = tabs
                .into_iter()
                .map(|tab| {
                    let target = shown
                        .iter()
                        .find(|target| Some(&target.id) == tab.chosen.as_ref());
                    json!({
                        "tab": tab.tab,
                        "target": tab.chosen,
                        "url": tab.url,
                        "title": tab.title,
                        "mode": target.map(|target| target.mode),
                        "mobile": target.map(|target| target.mobile),
                        "viewport": target.map(|target| json!({
                            "width": target.width,
                            "height": target.height,
                            "scale": target.scale,
                        })),
                    })
                })
                .collect();
            ToolOutput::text(Value::from(listed).to_string())
        };
        #[derive(Deserialize)]
        struct Asked {
            action: Option<String>,
            url: Option<String>,
            mode: Option<Mode>,
            reload: Option<bool>,
        }
        let asked: Asked = serde_json::from_value(args.clone()).context("invalid arguments")?;
        match asked.action.as_deref().unwrap_or("list") {
            "list" => Ok(targets(ctx.browser.tabs().await?)),
            "new" => {
                let options = TabOptions::default();
                let tab = ctx.browser.open_tab(asked.url.as_deref(), &options).await?;
                Ok(targets(vec![tab]))
            }
            "close" => {
                let tab = browse_core::require_tab(&args)?;
                ctx.browser.close_tab(tab).await?;
                Ok(ToolOutput::text(format!("closed tab {tab}")))
            }
            "mode" => {
                let tab = browse_core::require_tab(&args)?;
                let mode = asked
                    .mode
                    .context("pass the `mode`: auto, desktop or mobile")?;
                let tabs = ctx.browser.tabs().await?;
                let named = tabs.into_iter().find(|listed| listed.tab == tab);
                let target = named.and_then(|tab| tab.chosen).context("no such tab")?;
                let reload = asked.reload.unwrap_or(true);
                anyhow::ensure!(
                    self.shown.set_mode(&target, mode, None, reload),
                    "no such tab"
                );
                // What the tab is by now, which is told a moment after it is set.
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                let tabs = ctx.browser.tabs().await?;
                Ok(targets(
                    tabs.into_iter()
                        .filter(|listed| listed.tab == tab)
                        .collect(),
                ))
            }
            other => bail!("unknown action {other}; use list, new, close or mode"),
        }
    }
}

/// Recordings of a tab, as files of the session, and what their edits show.
pub(super) struct RecordingTool(pub Recordings);

#[async_trait]
impl Tool for RecordingTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "recording".into(),
            description: "Record a tab to a video file of the session, and say what the edited \
                video shows. `start` records `tab` (the newest tab when left out) from now on, \
                with the pointer in the picture, and returns the recording's `id`; how the \
                pointer moves meanwhile is the `pace` tool's. While it runs: `caption` \
                shows `text`; `focus` zooms on a `rect`, a `selector`'s element or the \
                `pointer` until `reset_focus`; `attention` circles the pointer around `x`,`y` \
                or a `selector`; `retarget` has recording `id` go on with another `tab`, which \
                a recording started with `follow` does by itself for the tab a tool acts \
                on. `stop` ends recording `id` and returns its raw video and journal at once; \
                the edit is made after, cut as `capture`, `idle`, `ripple`, `burst` and \
                `motion_threshold` say and at `fps` frames a second, and `status` tells when \
                its `edit` is `finished`, where the edited video is and what `options` made \
                it. `edit` makes the edit \
                of a stopped recording `id` again with other of those options, from the same \
                raw video: it takes the place of the edit before once it is made, and is \
                refused while an edit of the recording is being made, and for a recording \
                whose raw video is gone. `list` gives every recording. Annotations name the \
                recording by `id` when several run."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "start", "caption", "focus", "reset_focus", "attention", "retarget",
                            "stop", "edit",
                            "status", "list",
                        ],
                    },
                    "tab": {
                        "type": ["integer", "string"],
                        "description": "start: the tab's number or target id.",
                    },
                    "id": { "type": "string", "description": "The recording's id." },
                    "follow": {
                        "type": "boolean",
                        "description": "start: go on with whichever tab a tool acts on, in the same video.",
                    },
                    "capture": {
                        "type": "string",
                        "enum": ["continuous", "bursts"],
                        "description": "stop, edit: continuous (default), or bursts, which keeps only the stretches around what you did.",
                    },
                    "idle": {
                        "type": "string",
                        "enum": ["cut", "speed"],
                        "description": "stop, edit: remove, or fast-forward, the stretches in which nothing happens. Continuous capture only.",
                    },
                    "ripple": { "type": "boolean", "description": "stop, edit: mark clicks with a ripple." },
                    "motion_threshold": {
                        "type": "number",
                        "description": "stop, edit: the share of the picture, 0 to 1, that must change for something to have happened (default 0.0002). Lower it to keep subtle changes from being cut as idle.",
                    },
                    "fps": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 60,
                        "description": "stop, edit: the edited video's frames a second, 1 to 60 (default 60, which is the most the raw video has).",
                    },
                    "burst": {
                        "type": "object",
                        "description": "stop, edit: burst sizes in ms: lead_ms, tail_ms, settle_ms, max_tail_ms.",
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
        /// What the actions take, but for how a recording is edited and what its
        /// annotations are given.
        #[derive(Deserialize)]
        struct Asked {
            #[serde(default)]
            action: String,
            id: Option<String>,
            #[serde(default)]
            follow: bool,
        }
        let asked: Asked = serde_json::from_value(args.clone()).context("invalid arguments")?;
        let id = asked.id.as_deref();
        let named = || id.context("pass the recording's `id`");
        // How the edit is made, of what was passed of it.
        let options = || {
            let mut options = serde_json::Map::new();
            for key in [
                "capture",
                "idle",
                "ripple",
                "burst",
                "motion_threshold",
                "fps",
            ] {
                if let Some(value) = args.get(key).filter(|value| !value.is_null()) {
                    options.insert(key.to_owned(), value.clone());
                }
            }
            serde_json::from_value(options.into())
                .context("invalid capture, idle, ripple, burst, motion_threshold or fps")
        };
        match asked.action.as_str() {
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
                shown(&self.0.start(target.as_deref(), asked.follow).await?)
            }
            kind @ ("caption" | "focus" | "reset_focus" | "attention") => {
                let annotation = serde_json::from_value(args).context("invalid arguments")?;
                Ok(ToolOutput::text(self.0.annotate(kind, annotation).await?))
            }
            "retarget" => {
                let tab = args.get("tab").context("pass the `tab` to go on with")?;
                let tab = ctx.browser.resolve_tab(tab)?;
                shown(&self.0.retarget(named()?, &tab.to_string()).await?)
            }
            "stop" => shown(&self.0.stop(named()?, options()?).await?),
            "edit" => shown(&self.0.edit(named()?, options()?)?),
            "status" => shown(&self.0.get(named()?)?),
            "list" => shown(&self.0.list()),
            other => bail!("unknown action {other:?}"),
        }
    }
}

/// How the automation's pointer moves in a tab that is being recorded.
pub(super) struct PaceTool(pub Paced);

#[async_trait]
impl Tool for PaceTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "pace".into(),
            description: "How your pointer moves in a tab while it is recorded: `instant` (it \
                jumps to each action), `fast` (the default: quick travel the eye can follow, \
                and text typed out) or `slow` (unhurried, for demos). It is the session's: \
                the same for every recording and every caller, kept until it is set again, \
                also over a suspend. A tab nothing records gets its input at once whatever \
                the pace. Pass `pace` to set it; without it the tool tells what it is."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pace": { "type": "string", "enum": ["instant", "fast", "slow"] },
                },
            }),
        }
    }

    async fn call(&self, _ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        #[derive(Deserialize)]
        struct Asked {
            pace: Option<Pace>,
        }
        let asked: Asked =
            serde_json::from_value(args).context("pass a `pace` of instant, fast or slow")?;
        if let Some(pace) = asked.pace {
            self.0.set(pace);
        }
        shown(&json!({ "pace": self.0.get() }))
    }
}

/// A value as a tool shows it: JSON.
fn shown(value: &impl serde::Serialize) -> anyhow::Result<ToolOutput> {
    Ok(ToolOutput::text(serde_json::to_string_pretty(value)?))
}
