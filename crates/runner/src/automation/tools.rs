//! The tools that are the session's own: its tabs, and its recordings.

use anyhow::{Context, bail};
use async_trait::async_trait;
use browse_core::{TabInfo, TabOptions, Tool, ToolContext, ToolOutput, ToolSpec};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::live::record::Recordings;

/// The session's tabs: which there are, opening one, closing one.
pub(super) struct TabsTool;

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
        #[derive(Deserialize)]
        struct Asked {
            action: Option<String>,
            url: Option<String>,
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
            other => bail!("unknown action {other}; use list, new or close"),
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
                with the pointer in the picture, and returns the recording's `id`; `capture`, \
                `idle`, `ripple` and `burst` say how the edit is cut. While it runs: `caption` \
                shows `text`; `focus` zooms on a `rect`, a `selector`'s element or the \
                `pointer` until `reset_focus`; `attention` circles the pointer around `x`,`y` \
                or a `selector`; `retarget` has recording `id` go on with another `tab`, which \
                a recording that captures `bursts` does by itself for the tab a tool acts \
                on. `stop` ends recording `id` and returns its raw video and \
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
                            "start", "caption", "focus", "reset_focus", "attention", "retarget",
                            "stop",
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
                    "motion_threshold": {
                        "type": "number",
                        "description": "start: the share of the picture, 0 to 1, that must change for something to have happened (default 0.0002). Lower it to keep subtle changes from being cut as idle.",
                    },
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
        /// What the actions take, but for how a recording is started and what its
        /// annotations are given.
        #[derive(Deserialize)]
        struct Asked {
            #[serde(default)]
            action: String,
            id: Option<String>,
        }
        let asked: Asked = serde_json::from_value(args.clone()).context("invalid arguments")?;
        let id = asked.id.as_deref();
        let named = || id.context("pass the recording's `id`");
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
                let mut options = serde_json::Map::new();
                for key in [
                    "capture",
                    "idle",
                    "ripple",
                    "burst",
                    "pace",
                    "motion_threshold",
                ] {
                    if let Some(value) = args.get(key).filter(|value| !value.is_null()) {
                        options.insert(key.to_owned(), value.clone());
                    }
                }
                let options = serde_json::from_value(options.into())
                    .context("invalid capture, idle, ripple, burst, pace or motion_threshold")?;
                shown(&self.0.start(target.as_deref(), options).await?)
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
            "stop" => shown(&self.0.stop(named()?).await?),
            "status" => shown(&self.0.get(named()?)?),
            "list" => shown(&self.0.list()),
            other => bail!("unknown action {other:?}"),
        }
    }
}

/// A value as a tool shows it: JSON.
fn shown(value: &impl serde::Serialize) -> anyhow::Result<ToolOutput> {
    Ok(ToolOutput::text(serde_json::to_string_pretty(value)?))
}
