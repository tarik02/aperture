//! What automation adds to a recording for its edit: captions, zooms and the pointer drawing
//! attention to a place.

use std::{f64::consts::TAU, time::Duration};

use anyhow::{Context, bail, ensure};
use aperture_compositor::Input;
use serde::Serialize;
use serde_json::json;
use tokio::time::sleep;
use tracing::warn;

use super::{Entry, OpenFocus, Recordings, State};
use crate::cdp;

const CAPTION_MAX_CHARS: usize = 200;
const CAPTION_MS: (u64, u64, u64) = (3000, 200, 30_000);
const FOCUS_MAX_ZOOM: f64 = 4.0;
const FOCUS_MS: (u64, u64) = (200, 10_000);
/// A focus nobody reset zooms out after this.
const FOCUS_OPEN_FOR: Duration = Duration::from_secs(60);
/// How often an element a focus follows is looked at.
const FOCUS_TRACK_EVERY: Duration = Duration::from_millis(100);
const ATTENTION_MS: (u64, u64, u64) = (1200, 300, 5000);
const ATTENTION_RADIUS: (f64, f64, f64) = (40.0, 8.0, 300.0);
const ATTENTION_LOOPS: (u64, u64, u64) = (2, 1, 5);
const ATTENTION_STEP: Duration = Duration::from_millis(16);

#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
}

/// What a focus zooms on.
pub enum Subject {
    /// A fixed area of the page's viewport.
    Rect(Rect),
    /// An element, which the zoom follows as the page moves.
    Selector(String),
    /// The pointer, which the zoom follows as automation moves it.
    Pointer,
}

/// Where attention is drawn to.
pub enum Place {
    Point { x: f64, y: f64 },
    Selector(String),
}

impl Recordings {
    /// Shows a text in a recording's edit from now on, for `duration_ms`.
    pub fn caption(
        &self,
        id: Option<&str>,
        text: &str,
        duration_ms: Option<u64>,
    ) -> anyhow::Result<()> {
        let text = text.trim();
        let length = text.chars().count();
        ensure!(
            (1..=CAPTION_MAX_CHARS).contains(&length),
            "text must be 1 to {CAPTION_MAX_CHARS} characters"
        );
        let duration_ms = bounded(duration_ms, CAPTION_MS)?;
        let (id, _) = self.pick(id)?;
        let now = self.now();
        let recordings = self.0.recordings.lock().expect("not poisoned");
        let entry = recordings.get(&id).context("no such recording")?;
        let fields = json!({ "text": text, "duration_ms": duration_ms });
        entry.journal.add("caption", now, now, fields);
        Ok(())
    }

    /// Zooms a recording's edit on `subject`, until it is reset, replaced by another focus,
    /// the recording stops or a minute passes; or for `duration_ms`, which this then waits
    /// for.
    pub async fn focus(
        &self,
        id: Option<&str>,
        subject: Subject,
        zoom: f64,
        duration_ms: Option<u64>,
    ) -> anyhow::Result<()> {
        ensure!(
            zoom > 1.0 && zoom <= FOCUS_MAX_ZOOM,
            "zoom must be above 1 and at most {FOCUS_MAX_ZOOM}"
        );
        if let Some(duration) = duration_ms {
            ensure!(
                (FOCUS_MS.0..=FOCUS_MS.1).contains(&duration),
                "duration_ms must be {} to {}",
                FOCUS_MS.0,
                FOCUS_MS.1
            );
        }
        let (id, target) = self.pick(id)?;
        let (rect, follow, selector) = match subject {
            Subject::Rect(rect) => (rect, None, None),
            Subject::Selector(selector) => {
                let rect = self
                    .measure(&target, &selector)
                    .await?
                    .context("the selector matched no element")?;
                (rect, Some("element"), Some(selector))
            }
            Subject::Pointer => (
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 0.0,
                },
                Some("pointer"),
                None,
            ),
        };

        let serial = {
            let mut recordings = self.0.recordings.lock().expect("not poisoned");
            let entry = recordings.get_mut(&id).context("no such recording")?;
            ensure!(
                entry.recording.state == State::Recording,
                "the recording stopped"
            );
            self.close_focus(entry, None, "replaced");
            entry.focuses += 1;
            // The pointer is where automation last put it; before it moved, in the middle.
            let rect = match (follow, entry.pointer) {
                (Some("pointer"), Some((x, y))) => Rect { x, y, ..rect },
                (Some("pointer"), None) => self.middle(&target).unwrap_or(rect),
                _ => rect,
            };
            entry.focus = Some(OpenFocus {
                serial: entry.focuses,
                started: self.now(),
                rect,
                zoom,
                follow,
                track: Vec::new(),
            });
            entry.focuses
        };

        if let Some(selector) = selector {
            tokio::spawn(self.clone().track(id.clone(), serial, target, selector));
        }
        match duration_ms {
            Some(duration) => {
                sleep(Duration::from_millis(duration)).await;
                self.end_focus(&id, Some(serial), "duration");
            }
            None => {
                let recordings = self.clone();
                tokio::spawn(async move {
                    sleep(FOCUS_OPEN_FOR).await;
                    recordings.end_focus(&id, Some(serial), "expired");
                });
            }
        }
        Ok(())
    }

    /// Zooms a recording's edit out of its focus.
    pub fn reset_focus(&self, id: Option<&str>) -> anyhow::Result<()> {
        let (id, _) = self.pick(id)?;
        self.end_focus(&id, None, "reset");
        Ok(())
    }

    /// Circles the pointer around a place, so that whoever watches the recording looks
    /// there. It waits until the pointer is done.
    pub async fn attention(
        &self,
        id: Option<&str>,
        place: Place,
        radius: Option<f64>,
        loops: Option<u64>,
        duration_ms: Option<u64>,
    ) -> anyhow::Result<()> {
        let radius = radius.unwrap_or(ATTENTION_RADIUS.0);
        ensure!(
            (ATTENTION_RADIUS.1..=ATTENTION_RADIUS.2).contains(&radius),
            "radius must be {} to {}",
            ATTENTION_RADIUS.1,
            ATTENTION_RADIUS.2
        );
        let loops = bounded(loops, ATTENTION_LOOPS).map_err(|_| {
            anyhow::anyhow!(
                "loops must be {} to {}",
                ATTENTION_LOOPS.1,
                ATTENTION_LOOPS.2
            )
        })?;
        let duration = Duration::from_millis(bounded(duration_ms, ATTENTION_MS)?);
        let (id, target) = self.pick(id)?;
        let (x, y) = match place {
            Place::Point { x, y } => (x, y),
            Place::Selector(selector) => {
                let rect = self
                    .measure(&target, &selector)
                    .await?
                    .context("the selector matched no element")?;
                (rect.x + rect.width / 2.0, rect.y + rect.height / 2.0)
            }
        };
        let window = {
            let targets = self.0.targets.borrow();
            let shown = targets.iter().find(|shown| shown.id == target);
            shown
                .map(|shown| shown.window)
                .context("the recorded target is gone")?
        };

        let started = self.now();
        let begun = tokio::time::Instant::now();
        loop {
            let turned = (begun.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0);
            let angle = TAU * loops as f64 * turned;
            self.0.compositor.input(Input::PointerMotion {
                window,
                x: x + radius * angle.cos(),
                y: y + radius * angle.sin(),
            });
            if turned >= 1.0 {
                break;
            }
            sleep(ATTENTION_STEP).await;
        }
        let fields = json!({ "x": x, "y": y, "radius": radius, "loops": loops });
        let recordings = self.0.recordings.lock().expect("not poisoned");
        if let Some(entry) = recordings.get(&id) {
            entry.journal.add("attention", started, self.now(), fields);
        }
        Ok(())
    }

    /// The recording an annotation is for: the one named, or the only one that runs. Also
    /// the target it records.
    fn pick(&self, id: Option<&str>) -> anyhow::Result<(String, String)> {
        let recordings = self.0.recordings.lock().expect("not poisoned");
        let mut running = recordings
            .values()
            .map(|entry| &entry.recording)
            .filter(|recording| recording.state == State::Recording)
            .filter(|recording| id.is_none_or(|id| recording.id == id));
        match (running.next(), running.next()) {
            (Some(recording), None) => Ok((recording.id.clone(), recording.target.clone())),
            (None, _) => bail!("no such recording is running"),
            (Some(_), Some(_)) => {
                bail!("several recordings are running: pass the recording's `id`")
            }
        }
    }

    fn end_focus(&self, id: &str, serial: Option<u64>, reason: &str) {
        let mut recordings = self.0.recordings.lock().expect("not poisoned");
        if let Some(entry) = recordings.get_mut(id) {
            self.close_focus(entry, serial, reason);
        }
    }

    /// Ends the recording's focus and journals it; with `serial`, only when it is still
    /// that one.
    pub(super) fn close_focus(&self, entry: &mut Entry, serial: Option<u64>, reason: &str) {
        if serial
            .is_some_and(|serial| entry.focus.as_ref().map(|focus| focus.serial) != Some(serial))
        {
            return;
        }
        let Some(focus) = entry.focus.take() else {
            return;
        };
        let fields = json!({
            "rect": focus.rect,
            "zoom": focus.zoom,
            "follow": focus.follow,
            "track": focus.track,
            "ended": reason,
        });
        entry
            .journal
            .add("focus", focus.started, self.now(), fields);
    }

    /// Follows the element a focus is on for as long as the focus lasts, noting where it
    /// moved to.
    async fn track(self, id: String, serial: u64, target: String, selector: String) {
        let probe = match Probe::attach(&self.0.browser, &target).await {
            Ok(probe) => probe,
            Err(err) => {
                warn!(recording = %id, "a focus does not follow its element: {err:#}");
                return;
            }
        };
        let mut last = None;
        loop {
            sleep(FOCUS_TRACK_EVERY).await;
            // The page may be navigating: a look that fails is no end of the focus.
            let rect = probe.rect(&selector).await.ok().flatten();
            let mut recordings = self.0.recordings.lock().expect("not poisoned");
            let focus = recordings
                .get_mut(&id)
                .and_then(|entry| entry.focus.as_mut())
                .filter(|focus| focus.serial == serial);
            let Some(focus) = focus else {
                break;
            };
            if let Some(rect) = rect {
                let moved = (rect.x, rect.y, rect.width, rect.height);
                if last.replace(moved) != Some(moved) {
                    let at_ms = self.now().saturating_sub(focus.started).as_millis() as u64;
                    focus.track.push(json!({ "at_ms": at_ms, "rect": rect }));
                }
            }
        }
        probe.detach().await;
    }

    /// Where an element is in the target's viewport; none when there is no such element.
    async fn measure(&self, target: &str, selector: &str) -> anyhow::Result<Option<Rect>> {
        let probe = Probe::attach(&self.0.browser, target).await?;
        let rect = probe.rect(selector).await;
        probe.detach().await;
        rect
    }

    /// The middle of the target's viewport, as a rectangle without a size.
    fn middle(&self, target: &str) -> Option<Rect> {
        let targets = self.0.targets.borrow();
        let shown = targets.iter().find(|shown| shown.id == target)?;
        Some(Rect {
            x: f64::from(shown.width) / 2.0,
            y: f64::from(shown.height) / 2.0,
            width: 0.0,
            height: 0.0,
        })
    }
}

/// A value an annotation gives or leaves to its default, within its bounds.
fn bounded(value: Option<u64>, (default, low, high): (u64, u64, u64)) -> anyhow::Result<u64> {
    let value = value.unwrap_or(default);
    ensure!(
        (low..=high).contains(&value),
        "duration_ms must be {low} to {high}"
    );
    Ok(value)
}

/// A DevTools session on a target, for looking at where its elements are.
struct Probe<'a> {
    browser: &'a cdp::Client,
    session: String,
}

impl<'a> Probe<'a> {
    async fn attach(browser: &'a cdp::Client, target: &str) -> anyhow::Result<Self> {
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
        Ok(Self { browser, session })
    }

    async fn rect(&self, selector: &str) -> anyhow::Result<Option<Rect>> {
        let selector = serde_json::to_string(selector)?;
        let expression = format!(
            "(() => {{ const e = document.querySelector({selector}); if (!e) return null; \
             const r = e.getBoundingClientRect(); \
             return {{ x: r.x, y: r.y, width: r.width, height: r.height }}; }})()"
        );
        let evaluated = self
            .browser
            .call_in(
                Some(&self.session),
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await?;
        ensure!(
            evaluated.get("exceptionDetails").is_none(),
            "the selector is not valid"
        );
        let rect = evaluated["result"]["value"].clone();
        serde_json::from_value(rect).context("the element's place is not read")
    }

    async fn detach(self) {
        let detach = json!({ "sessionId": self.session });
        // A target that closed took the session with it.
        let _ = self.browser.call("Target.detachFromTarget", detach).await;
    }
}
