//! SPIKE. A session whose browser runs headless: no window of it is ever drawn by the
//! compositor. What the compositor does for a session is done here instead, as far as the
//! spike goes: a tab's picture is captured and encoded by the browser itself and handed
//! over by the session's extension, input goes to the page over DevTools, and a tab's size
//! is the size of its window's contents.
//!
//! Nothing that reads a window's pixels works: recordings, screenshots, tiles, the
//! clipboard, the pointer's shape.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::Context;
use aperture_compositor::{Button, Input, Viewport, WindowId, WindowInfo};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, watch};
use tracing::{debug, warn};

use crate::{
    cdp,
    live::stream::{Packet, Shared},
    targets::Target,
};

/// Clicks this close in time and place count as one double click.
const DOUBLE_WITHIN: Duration = Duration::from_millis(400);
/// What a notch of the wheel scrolls, in the page's pixels.
const NOTCH: f64 = 100.0;

pub struct Headless {
    windows: watch::Sender<Vec<WindowInfo>>,
    next: AtomicU32,
    viewport: Viewport,
    /// What the extension is told.
    pushes: broadcast::Sender<Value>,
    /// The video of each tab, by the browser's id of it.
    video: Mutex<HashMap<i64, Arc<Shared>>>,
    input: mpsc::UnboundedSender<Input>,
    attached: OnceLock<(cdp::Client, watch::Receiver<Vec<Target>>)>,
    /// The DevTools session of each page input goes to.
    sessions: tokio::sync::Mutex<HashMap<String, String>>,
    started: Instant,
}

impl Headless {
    pub fn new(viewport: Viewport) -> Arc<Self> {
        let (input, taken) = mpsc::unbounded_channel();
        let headless = Arc::new(Self {
            windows: watch::Sender::new(Vec::new()),
            next: AtomicU32::new(1),
            viewport,
            pushes: broadcast::Sender::new(64),
            video: Mutex::default(),
            input,
            attached: OnceLock::new(),
            sessions: tokio::sync::Mutex::default(),
            started: Instant::now(),
        });
        tokio::spawn(headless.clone().give(taken));
        headless
    }

    pub fn windows(&self) -> watch::Receiver<Vec<WindowInfo>> {
        self.windows.subscribe()
    }

    /// What is to be told the extension, as it comes.
    pub fn pushes(&self) -> broadcast::Receiver<Value> {
        self.pushes.subscribe()
    }

    /// A window that stands for the browser's own, which nobody draws.
    pub fn open(&self, tag: &str) -> WindowId {
        let id = WindowId(self.next.fetch_add(1, Ordering::Relaxed));
        self.windows.send_modify(|windows| {
            windows.push(WindowInfo {
                id,
                parent: None,
                tag: Some(tag.to_owned()),
                title: String::new(),
                app_id: String::new(),
                width: self.viewport.width,
                height: self.viewport.height,
                scale: 1.0,
            });
        });
        id
    }

    pub fn close(&self, window: WindowId) {
        self.windows
            .send_modify(|windows| windows.retain(|open| open.id != window));
    }

    /// Takes the browser and the session's targets, and gives each target the size its
    /// window has as it comes.
    pub fn attach(self: &Arc<Self>, browser: cdp::Client, targets: watch::Receiver<Vec<Target>>) {
        let mut seen = targets.clone();
        if self.attached.set((browser, targets)).is_err() {
            return;
        }
        let headless = self.clone();
        tokio::spawn(async move {
            let mut sized: Vec<String> = Vec::new();
            seen.mark_changed();
            while seen.changed().await.is_ok() {
                let now: Vec<Target> = seen.borrow_and_update().clone();
                for target in &now {
                    if sized.contains(&target.id) {
                        continue;
                    }
                    sized.push(target.id.clone());
                    headless.size(target.window).await;
                }
                sized.retain(|id| now.iter().any(|target| target.id == *id));
            }
        });
    }

    pub fn set_viewport(self: &Arc<Self>, window: WindowId, viewport: Viewport) {
        let viewport = viewport.bounded();
        self.windows.send_modify(|windows| {
            if let Some(open) = windows.iter_mut().find(|open| open.id == window) {
                // Video is of even sizes.
                open.width = viewport.width & !1;
                open.height = viewport.height & !1;
            }
        });
        let headless = self.clone();
        tokio::spawn(async move { headless.size(window).await });
    }

    /// Gives the contents of the browser's window the size the window here has.
    async fn size(&self, window: WindowId) {
        let size = {
            let windows = self.windows.borrow();
            let open = windows.iter().find(|open| open.id == window);
            open.map(|open| (open.width, open.height))
        };
        let (Some((width, height)), Some((target, tab))) = (size, self.target(window)) else {
            return;
        };
        let Some((browser, _)) = self.attached.get() else {
            return;
        };
        let _ = self
            .pushes
            .send(json!({ "type": "video.size", "tabId": tab, "width": width, "height": height }));
        let sized = async {
            let found = browser
                .call("Browser.getWindowForTarget", json!({ "targetId": target }))
                .await?;
            let contents = json!({
                "windowId": found["windowId"],
                "width": width,
                "height": height,
            });
            browser.call("Browser.setContentsSize", contents).await
        };
        if let Err(err) = sized.await {
            warn!(?window, "a headless tab keeps the size it has: {err}");
        }
    }

    fn target(&self, window: WindowId) -> Option<(String, i64)> {
        let (_, targets) = self.attached.get()?;
        let targets = targets.borrow();
        let target = targets.iter().find(|target| target.window == window)?;
        Some((target.id.clone(), target.browser_tab))
    }

    /// The video of a tab, which the extension feeds. It has a keyframe when one is asked
    /// for, as soon as the tab draws again.
    pub fn video(&self, tab: i64) -> Arc<Shared> {
        let mut video = self.video.lock().expect("not poisoned");
        video
            .entry(tab)
            .or_insert_with(|| {
                let shared = Arc::new(Shared::new());
                let (asked, pushes) = (shared.clone(), self.pushes.clone());
                tokio::spawn(async move {
                    loop {
                        asked.keyframe.notified().await;
                        let _ = pushes.send(json!({ "type": "video.keyframe", "tabId": tab }));
                    }
                });
                shared
            })
            .clone()
    }

    /// Has a tab's video spend what a taker's link carries. One video goes to all who
    /// watch the tab, so the last word counts.
    pub fn want(&self, tab: i64, kbits: Option<u32>, fps: u32) {
        let bitrate = kbits.unwrap_or(6000) * 1000;
        let wanted =
            json!({ "type": "video.quality", "tabId": tab, "bitrate": bitrate, "fps": fps });
        let _ = self.pushes.send(wanted);
    }

    /// Takes what the extension tells of a tab's video.
    pub fn told(&self, message: &Value) -> anyhow::Result<()> {
        match message["type"].as_str() {
            Some("video.packet") => {
                let tab = message["tabId"].as_i64().context("a packet of no tab")?;
                let data = STANDARD.decode(message["data"].as_str().unwrap_or_default())?;
                let size = |side: &str| message[side].as_u64().unwrap_or(0) as u32;
                let packet = Packet {
                    data,
                    time: self.started.elapsed(),
                    keyframe: message["key"].as_bool().unwrap_or(false),
                    changed: 0,
                    size: (size("width"), size("height")),
                };
                // Nobody taking it right now is fine.
                let _ = self.video(tab).packets.send(Arc::new(packet));
            }
            Some("video.started") => {
                tracing::info!(tab = ?message["tabId"], encoder = ?message["encoder"], "tab captured");
            }
            Some("video.failed") => {
                warn!(tab = ?message["tabId"], "a tab's video failed: {}", message["error"]);
            }
            other => debug!(?other, "the extension said something about video"),
        }
        Ok(())
    }

    /// Input for a page, in the order it is given.
    pub fn input(&self, input: Input) {
        let _ = self.input.send(input);
    }

    async fn session(&self, window: WindowId) -> Option<(cdp::Client, String)> {
        let (target, _) = self.target(window)?;
        let (browser, _) = self.attached.get()?;
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(&target) {
            return Some((browser.clone(), session.clone()));
        }
        let attach = json!({ "targetId": target, "flatten": true });
        let attached = browser.call("Target.attachToTarget", attach).await.ok()?;
        let session = attached["sessionId"].as_str()?.to_owned();
        sessions.insert(target, session.clone());
        Some((browser.clone(), session))
    }

    async fn give(self: Arc<Self>, mut taken: mpsc::UnboundedReceiver<Input>) {
        let mut hands = Hands::default();
        let mut waiting: std::collections::VecDeque<Input> = std::collections::VecDeque::new();
        loop {
            // A page answers each event once it has taken it, which is slower than a
            // pointer moves: of the moves that wait, only where the pointer is now counts.
            while let Ok(more) = taken.try_recv() {
                let both = matches!(
                    (waiting.back(), &more),
                    (
                        Some(Input::PointerMotion { .. }),
                        Input::PointerMotion { .. }
                    )
                );
                if both {
                    waiting.pop_back();
                }
                waiting.push_back(more);
            }
            let input = match waiting.pop_front() {
                Some(input) => input,
                None => match taken.recv().await {
                    Some(input) => input,
                    None => return,
                },
            };
            let Some((window, method, params)) = hands.say(input) else {
                continue;
            };
            let Some((browser, session)) = self.session(window).await else {
                continue;
            };
            if let Err(err) = browser.call_in(Some(&session), method, params).await {
                debug!("a page did not take input: {err}");
                // The page may be another one by now.
                self.sessions.lock().await.clear();
            }
        }
    }
}

/// What is held down, which DevTools is told with every event.
#[derive(Default)]
struct Hands {
    buttons: u32,
    modifiers: u32,
    clicked: Option<(Instant, f64, f64, u32)>,
}

impl Hands {
    fn say(&mut self, input: Input) -> Option<(WindowId, &'static str, Value)> {
        match input {
            Input::PointerMotion { window, x, y } => Some((
                window,
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseMoved", "x": x, "y": y, "buttons": self.buttons, "modifiers": self.modifiers }),
            )),
            Input::PointerButton {
                window,
                x,
                y,
                button,
                pressed,
            } => {
                let (name, bit) = match button {
                    Button::Left => ("left", 1),
                    Button::Right => ("right", 2),
                    Button::Middle => ("middle", 4),
                    Button::Back => ("back", 8),
                    Button::Forward => ("forward", 16),
                };
                if pressed {
                    self.buttons |= bit;
                    let again = self.clicked.filter(|(at, was_x, was_y, _)| {
                        at.elapsed() < DOUBLE_WITHIN
                            && (was_x - x).abs() < 4.0
                            && (was_y - y).abs() < 4.0
                    });
                    let count = again.map_or(1, |(.., count)| count + 1);
                    self.clicked = Some((Instant::now(), x, y, count));
                } else {
                    self.buttons &= !bit;
                }
                let count = self.clicked.map_or(1, |(.., count)| count);
                Some((
                    window,
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": if pressed { "mousePressed" } else { "mouseReleased" },
                        "x": x, "y": y, "button": name, "buttons": self.buttons,
                        "clickCount": count, "modifiers": self.modifiers,
                    }),
                ))
            }
            Input::PointerScroll {
                window,
                x,
                y,
                dx,
                dy,
            } => Some((
                window,
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel", "x": x, "y": y,
                    "deltaX": dx * NOTCH, "deltaY": dy * NOTCH, "modifiers": self.modifiers,
                }),
            )),
            Input::Key {
                window,
                code,
                pressed,
            } => {
                let modifier = match code {
                    56 | 100 => 1,
                    29 | 97 => 2,
                    125 | 126 => 4,
                    42 | 54 => 8,
                    _ => 0,
                };
                if pressed {
                    self.modifiers |= modifier;
                } else {
                    self.modifiers &= !modifier;
                }
                let (name, vk, plain, shifted) = key(code)?;
                let shift = self.modifiers & 8 != 0;
                let key = if shift { shifted } else { plain };
                // A key that writes says what it writes, unless it is a shortcut.
                let writes = key.chars().count() == 1 && self.modifiers & 0b111 == 0;
                let text = match (writes, key) {
                    (true, key) => Some(key),
                    (false, "Enter") => Some("\r"),
                    _ => None,
                };
                let kind = match (pressed, text) {
                    (false, _) => "keyUp",
                    (true, Some(_)) => "keyDown",
                    (true, None) => "rawKeyDown",
                };
                let mut event = json!({
                    "type": kind, "code": name, "key": key,
                    "windowsVirtualKeyCode": vk, "modifiers": self.modifiers,
                });
                if let Some(text) = text.filter(|_| pressed) {
                    event["text"] = text.into();
                }
                Some((window, "Input.dispatchKeyEvent", event))
            }
            Input::Text {
                window,
                text,
                composing: false,
            } => Some((window, "Input.insertText", json!({ "text": text }))),
            Input::Text { .. } | Input::Drop { .. } | Input::PointerLeave => None,
        }
    }
}

/// A key by its evdev code: its DOM code, its Windows virtual key code, and what it is
/// called alone and with shift, on a US keyboard.
fn key(code: u32) -> Option<(&'static str, u32, &'static str, &'static str)> {
    const LETTERS: [(u32, char); 26] = [
        (30, 'A'),
        (48, 'B'),
        (46, 'C'),
        (32, 'D'),
        (18, 'E'),
        (33, 'F'),
        (34, 'G'),
        (35, 'H'),
        (23, 'I'),
        (36, 'J'),
        (37, 'K'),
        (38, 'L'),
        (50, 'M'),
        (49, 'N'),
        (24, 'O'),
        (25, 'P'),
        (16, 'Q'),
        (19, 'R'),
        (31, 'S'),
        (20, 'T'),
        (22, 'U'),
        (47, 'V'),
        (17, 'W'),
        (45, 'X'),
        (21, 'Y'),
        (44, 'Z'),
    ];
    const LETTER_KEYS: [(&str, &str, &str); 26] = [
        ("KeyA", "a", "A"),
        ("KeyB", "b", "B"),
        ("KeyC", "c", "C"),
        ("KeyD", "d", "D"),
        ("KeyE", "e", "E"),
        ("KeyF", "f", "F"),
        ("KeyG", "g", "G"),
        ("KeyH", "h", "H"),
        ("KeyI", "i", "I"),
        ("KeyJ", "j", "J"),
        ("KeyK", "k", "K"),
        ("KeyL", "l", "L"),
        ("KeyM", "m", "M"),
        ("KeyN", "n", "N"),
        ("KeyO", "o", "O"),
        ("KeyP", "p", "P"),
        ("KeyQ", "q", "Q"),
        ("KeyR", "r", "R"),
        ("KeyS", "s", "S"),
        ("KeyT", "t", "T"),
        ("KeyU", "u", "U"),
        ("KeyV", "v", "V"),
        ("KeyW", "w", "W"),
        ("KeyX", "x", "X"),
        ("KeyY", "y", "Y"),
        ("KeyZ", "z", "Z"),
    ];
    if let Some((_, letter)) = LETTERS.iter().find(|(evdev, _)| *evdev == code) {
        let at = (*letter as u8 - b'A') as usize;
        let (name, plain, shifted) = LETTER_KEYS[at];
        return Some((name, *letter as u32, plain, shifted));
    }
    Some(match code {
        2 => ("Digit1", 49, "1", "!"),
        3 => ("Digit2", 50, "2", "@"),
        4 => ("Digit3", 51, "3", "#"),
        5 => ("Digit4", 52, "4", "$"),
        6 => ("Digit5", 53, "5", "%"),
        7 => ("Digit6", 54, "6", "^"),
        8 => ("Digit7", 55, "7", "&"),
        9 => ("Digit8", 56, "8", "*"),
        10 => ("Digit9", 57, "9", "("),
        11 => ("Digit0", 48, "0", ")"),
        12 => ("Minus", 189, "-", "_"),
        13 => ("Equal", 187, "=", "+"),
        26 => ("BracketLeft", 219, "[", "{"),
        27 => ("BracketRight", 221, "]", "}"),
        39 => ("Semicolon", 186, ";", ":"),
        40 => ("Quote", 222, "'", "\""),
        41 => ("Backquote", 192, "`", "~"),
        43 => ("Backslash", 220, "\\", "|"),
        51 => ("Comma", 188, ",", "<"),
        52 => ("Period", 190, ".", ">"),
        53 => ("Slash", 191, "/", "?"),
        57 => ("Space", 32, " ", " "),
        1 => ("Escape", 27, "Escape", "Escape"),
        14 => ("Backspace", 8, "Backspace", "Backspace"),
        15 => ("Tab", 9, "Tab", "Tab"),
        28 => ("Enter", 13, "Enter", "Enter"),
        96 => ("NumpadEnter", 13, "Enter", "Enter"),
        29 => ("ControlLeft", 17, "Control", "Control"),
        97 => ("ControlRight", 17, "Control", "Control"),
        42 => ("ShiftLeft", 16, "Shift", "Shift"),
        54 => ("ShiftRight", 16, "Shift", "Shift"),
        56 => ("AltLeft", 18, "Alt", "Alt"),
        100 => ("AltRight", 18, "Alt", "Alt"),
        125 => ("MetaLeft", 91, "Meta", "Meta"),
        126 => ("MetaRight", 92, "Meta", "Meta"),
        102 => ("Home", 36, "Home", "Home"),
        107 => ("End", 35, "End", "End"),
        104 => ("PageUp", 33, "PageUp", "PageUp"),
        109 => ("PageDown", 34, "PageDown", "PageDown"),
        103 => ("ArrowUp", 38, "ArrowUp", "ArrowUp"),
        108 => ("ArrowDown", 40, "ArrowDown", "ArrowDown"),
        105 => ("ArrowLeft", 37, "ArrowLeft", "ArrowLeft"),
        106 => ("ArrowRight", 39, "ArrowRight", "ArrowRight"),
        110 => ("Insert", 45, "Insert", "Insert"),
        111 => ("Delete", 46, "Delete", "Delete"),
        _ => return None,
    })
}
