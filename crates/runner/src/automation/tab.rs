//! A tab as `browse` drives it: its DevTools session, with pointer and key input going to
//! the compositor instead, where those who watch see it.

use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::Context;
use aperture_compositor::{Button, Input, WindowId};
use async_trait::async_trait;
use browse_core::{Cdp, CdpError, CdpEvent};
use serde_json::{Value, json};
use tokio::{
    sync::{broadcast, watch},
    time::{Instant, sleep, sleep_until, timeout},
};

use super::keys::evdev_code;
use crate::{
    cdp,
    live::record::Recordings,
    pace::{Pace, Paced},
    presence::{MemberId, Presence},
    targets::Target,
};

/// How long the automation waits for a tab a person drives before it gives up on it.
const TAB_FREE_WITHIN: Duration = Duration::from_secs(15);
/// How long the page gets to take in input the compositor delivered, before the command
/// that caused it counts as done.
const INPUT_SETTLES_WITHIN: Duration = Duration::from_millis(500);
/// How long a character of a text takes to type at a fast pace, and how long a whole text
/// takes at most.
const TYPING_STEP: Duration = Duration::from_millis(35);
const TYPING_AT_MOST: Duration = Duration::from_secs(3);
/// What a slow pace adds to each step of the pointer's travel.
const SLOW_STEP: Duration = Duration::from_millis(14);
/// Input that came this soon after the input before it is of one gesture with it, and
/// goes as far after it as it came.
const GESTURE_GAP: Duration = Duration::from_secs(1);
/// How long a picture of the page may take. The browser answers once the page draws, and
/// a page whose window shows another draws nothing: without a bound, the caller would
/// wait for as long as its own patience lasts and learn nothing.
const DRAWN_WITHIN: Duration = Duration::from_secs(30);

/// Where the tab's input stands: it goes one at a time, in the order it came.
#[derive(Default)]
struct Turn {
    /// When the last input came, and when it went.
    last: Option<(Instant, Instant)>,
    /// When input was last refused for a tab someone else held all the while: what came
    /// before then is refused with it, rather than wait as long again.
    refused: Option<Instant>,
}

/// A tab's DevTools session, attached through the browser's connection.
pub(super) struct TabSession {
    browser: cdp::Client,
    targets: watch::Receiver<Vec<Target>>,
    recordings: Recordings,
    pace: Paced,
    target: String,
    session: String,
    presence: Arc<Presence>,
    /// The member the automation acts as in the tab: whoever called a tool on it last,
    /// and nobody until a tool is.
    actor: Mutex<Option<MemberId>>,
    /// Input to the tab waits here for the input before it. A gesture is sent a sample at
    /// a time without waiting for each to arrive, so samples that wait for the tab to be
    /// free would otherwise go once it is in whatever order they wake in, and a press
    /// amid the travel before it.
    turn: tokio::sync::Mutex<Turn>,
    /// Where the tab's events go; none once the session ended, which closes the streams of
    /// those who listen.
    events: Mutex<Option<broadcast::Sender<CdpEvent>>>,
}

impl TabSession {
    pub async fn attach(
        browser: cdp::Client,
        targets: watch::Receiver<Vec<Target>>,
        recordings: Recordings,
        pace: Paced,
        target: String,
        presence: Arc<Presence>,
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
            targets,
            recordings,
            pace,
            target,
            session,
            presence,
            actor: Mutex::new(None),
            turn: tokio::sync::Mutex::default(),
            events: Mutex::new(Some(events.clone())),
        });

        // Events of the tab's session are the tab's own; those of the sessions attached
        // below it, such as out-of-process frames, are passed on under their session id.
        let tab = Arc::downgrade(&attached);
        let own = attached.session.clone();
        tokio::spawn(async move {
            let mut children: HashSet<String> = HashSet::new();
            while let Some(event) = browser_events.next().await {
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

    pub fn is_attached(&self) -> bool {
        self.events.lock().expect("not poisoned").is_some()
    }

    /// What the automation does in the tab from now on is this member's.
    pub fn acts_as(&self, actor: MemberId) {
        *self.actor.lock().expect("not poisoned") = Some(actor);
    }

    fn actor(&self) -> Option<MemberId> {
        *self.actor.lock().expect("not poisoned")
    }

    /// The tab's number.
    fn tab(&self) -> Option<u32> {
        self.targets
            .borrow()
            .iter()
            .find(|target| target.id == self.target)
            .map(|target| target.tab)
    }

    /// The window that shows the tab now.
    fn window(&self) -> Option<WindowId> {
        self.targets
            .borrow()
            .iter()
            .find(|target| target.id == self.target)
            .map(|target| target.window)
    }

    /// Inserts text a character at a time, as typing looks, where the browser would insert
    /// it at once: what a recording at a pace shows of a field being filled. False when the
    /// text is to go in at once after all.
    /// The session's pace, while the tab is being recorded: nothing is slowed for a tab
    /// that nothing records.
    fn pace(&self) -> Option<Pace> {
        self.recordings
            .records(&self.target)
            .then(|| self.pace.get())
    }

    async fn type_out(&self, text: &str, pace: Pace) -> Result<bool, CdpError> {
        let (each, at_most) = match pace {
            Pace::Instant => return Ok(false),
            Pace::Fast => (TYPING_STEP, TYPING_AT_MOST),
            Pace::Slow => (TYPING_STEP * 2, TYPING_AT_MOST * 2),
        };
        let characters: Vec<char> = text.chars().collect();
        if characters.len() < 2 {
            return Ok(false);
        }
        // A long text is typed faster, so that no field takes too long to fill.
        let each = each.min(at_most / characters.len() as u32);
        let mut character = [0; 4];
        for typed in characters {
            let text = typed.encode_utf8(&mut character);
            self.browser
                .call_in(
                    Some(&self.session),
                    "Input.insertText",
                    json!({ "text": text }),
                )
                .await
                .map_err(CdpError::from)?;
            sleep(each).await;
        }
        Ok(true)
    }

    /// Gives pointer and key commands to the compositor instead of the page. `None` for
    /// what the compositor has no input for, which goes to the page as it is.
    async fn deliver(&self, method: &str, params: &Value) -> Option<()> {
        let window = self.window()?;
        // The page's pixels, which a window has more of where the page is narrower than
        // a window gets.
        let zoom = {
            let targets = self.targets.borrow();
            let target = targets.iter().find(|target| target.id == self.target);
            target.map_or(1.0, |target| target.zoom)
        };
        let (input, settles) = match (method, params["type"].as_str()?) {
            ("Input.dispatchMouseEvent", "mouseMoved") => (
                Input::PointerMotion {
                    window,
                    x: params["x"].as_f64()? * zoom,
                    y: params["y"].as_f64()? * zoom,
                },
                false,
            ),
            ("Input.dispatchMouseEvent", kind @ ("mousePressed" | "mouseReleased")) => (
                Input::PointerButton {
                    window,
                    x: params["x"].as_f64()? * zoom,
                    y: params["y"].as_f64()? * zoom,
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
                let fields = json!({ "x": x / zoom, "y": y / zoom });
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
                    "x": x / zoom,
                    "y": y / zoom,
                    "button": params["button"],
                    "count": params["clickCount"].as_u64().unwrap_or(1),
                });
                self.recordings
                    .note(Some(&self.target), "press", now, fields);
            }
            _ => {}
        }
        let travelled = matches!(input, Input::PointerMotion { .. });
        self.presence.input(self.actor()?, self.tab()?, input);
        // A slow pace takes each step of the pointer's way about twice as long.
        if travelled && self.pace() == Some(Pace::Slow) {
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
            // A page that is busy or on its way elsewhere has the input no sooner for the
            // waiting: the command is done either way.
            let _ = timeout(INPUT_SETTLES_WITHIN, frame).await;
        }
        Some(())
    }
}

impl From<cdp::Error> for CdpError {
    fn from(err: cdp::Error) -> Self {
        match err {
            cdp::Error::Refused(message) => Self::Protocol(message),
            cdp::Error::Detached => Self::Protocol(err.to_string()),
            cdp::Error::Gone => Self::Disconnected,
        }
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
        let came = Instant::now();
        let mut turn = if method.starts_with("Input.") && session_id.is_none() {
            Some(self.turn.lock().await)
        } else {
            None
        };
        // Input is the tab's holder's: the automation takes a tab nobody holds, and waits
        // for one a person drives, or another of its callers, until they are done with it.
        if let Some(turn) = &mut turn
            && let Some(tab) = self.tab()
        {
            let Some(actor) = self.actor() else {
                return Err(CdpError::Protocol(format!("nobody acts in tab {tab}")));
            };
            let waited = Instant::now();
            while !self.presence.hold(actor, tab, true) {
                let refused = turn.refused.is_some_and(|refused| came <= refused);
                if refused || waited.elapsed() >= TAB_FREE_WITHIN {
                    turn.refused = Some(Instant::now());
                    let holder = self.presence.held_by_another(actor, tab);
                    let holder = holder.unwrap_or_else(|| "someone".to_owned());
                    return Err(CdpError::Protocol(format!(
                        "tab {tab} is driven by {holder} right now; try again when they are done"
                    )));
                }
                sleep(Duration::from_millis(200)).await;
            }
        }
        // Input that waited goes as far after the input before it as it came after it, so
        // that a travel that waited for the tab still travels.
        if let Some(turn) = &mut turn {
            if let Some((before_came, before_went)) = turn.last {
                let gap = came.saturating_duration_since(before_came);
                if gap < GESTURE_GAP {
                    sleep_until(before_went + gap).await;
                }
            }
            turn.last = Some((came, Instant::now()));
        }
        let input = matches!(
            method,
            "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent"
        );
        if input && session_id.is_none() && self.deliver(method, &params).await.is_some() {
            return Ok(json!({}));
        }
        if method == "Input.insertText"
            && session_id.is_none()
            && let Some(pace) = self.pace()
            && let Some(text) = params["text"].as_str()
            && self.type_out(text, pace).await?
        {
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
        let call = self
            .browser
            .call_in(Some(session_id.unwrap_or(&self.session)), method, params);
        if method != "Page.captureScreenshot" {
            return call.await.map_err(CdpError::from);
        }
        match timeout(DRAWN_WITHIN, call).await {
            Ok(answer) => answer.map_err(CdpError::from),
            Err(_) => {
                let tab = self
                    .tab()
                    .map_or_else(|| self.target.clone(), |tab| tab.to_string());
                Err(CdpError::Protocol(format!(
                    "tab {tab} drew nothing for {} s: its window may show another page",
                    DRAWN_WITHIN.as_secs()
                )))
            }
        }
    }

    fn events(&self) -> broadcast::Receiver<CdpEvent> {
        match &*self.events.lock().expect("not poisoned") {
            Some(events) => events.subscribe(),
            // Closed from the start.
            None => broadcast::channel(1).1,
        }
    }
}
