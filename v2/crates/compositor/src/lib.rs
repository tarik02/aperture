//! The compositor of one session: a headless Wayland server for the session's browser. It
//! owns no screen. Every window is drawn on its own, at the session's viewport size, and
//! whoever watches a window gets its frames, as pixels or where the GPU drew them; input
//! goes to a window by its own coordinates.
//!
//! The Wayland state lives on a thread of its own, behind [`Handle`].

mod cursor;
pub mod data;
mod handlers;
mod input;
mod keymap;
mod render;
mod state;
mod text;

use std::{
    os::fd::BorrowedFd,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread::JoinHandle,
    time::{Duration, Instant},
};

use smithay::{
    backend::allocator::{Buffer as _, dmabuf::Dmabuf},
    reexports::calloop::{EventLoop, channel},
};
use tokio::sync::{oneshot, watch};

pub use crate::data::{Form, Forms};
use crate::state::{Job, State};

#[derive(Debug, Clone)]
pub struct Config {
    /// Where the Wayland socket is made.
    pub socket: PathBuf,
    pub viewport: Viewport,
    /// The cursor theme the pointer is drawn from, a directory with `cursors` in it. Without
    /// one, only cursors that clients draw themselves can be drawn.
    pub cursor_theme: Option<PathBuf>,
    /// Whether windows are drawn on a GPU, where one works, and clients may share their
    /// GPU buffers. Without, everything is drawn on the CPU.
    pub gpu: bool,
    /// The layouts (DRM format modifiers) of RGBA buffers that whoever takes frames takes
    /// on the GPU: frames are drawn into such, where the GPU does, and stay there.
    pub frame_layouts: Vec<u64>,
}

/// The size a window without a parent is given, in logical pixels, and how many pixels it
/// draws to each of them. Every such window has its own; one is given the session's until
/// it is given another.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

impl Viewport {
    /// The longest side of a picture, in pixels: what video encoders take.
    pub const LONGEST: u32 = 4096;
    pub const SMALLEST: u32 = 64;

    /// The viewport as near to this one as windows can be given.
    pub fn bounded(self) -> Self {
        let width = self.width.clamp(Self::SMALLEST, Self::LONGEST);
        let height = self.height.clamp(Self::SMALLEST, Self::LONGEST);
        let most = f64::from(Self::LONGEST) / f64::from(width.max(height));
        let scale = if self.scale.is_finite() {
            self.scale
        } else {
            1.0
        };
        // In the steps clients are told a scale in.
        let scale = (scale.clamp(0.5, most.clamp(0.5, 4.0)) * 120.0).floor() / 120.0;
        Self {
            width,
            height,
            scale,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WindowId(pub u32);

#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    pub id: WindowId,
    /// The window this one is a dialog of.
    pub parent: Option<WindowId>,
    /// What the window was expected as, see [`Handle::expect`].
    pub tag: Option<String>,
    pub title: String,
    pub app_id: String,
    /// In logical pixels.
    pub width: u32,
    pub height: u32,
    /// How many pixels the window draws to each logical one.
    pub scale: f64,
}

/// A window as drawn: the window's own area, grown right and down by the popups that stick
/// out of it. Its origin is the origin of input coordinates.
pub struct Frame {
    /// In pixels.
    pub width: u32,
    pub height: u32,
    /// How many pixels there are to each logical one.
    pub scale: f64,
    /// Tightly packed premultiplied RGBA. Empty for a frame that stayed on the GPU, which
    /// one does unless someone asked for the window's [`Pixels`].
    pub rgba: Vec<u8>,
    /// The frame where it was drawn, when that is on the GPU and in a layout its takers
    /// take.
    pub buffer: Option<GpuBuffer>,
    /// On the compositor's clock, which starts with it.
    pub time: Duration,
    /// How many pixels changed since the window was first watched, counted up from frame
    /// to frame: by how much it grew between two frames says how much of the picture
    /// changed between them, also when frames in between were skipped. Flicker is not
    /// counted: a small area that changes at a steady beat, as a blinking caret does.
    ///
    /// Counted from the pixels where the frames come with them. A frame that stayed on
    /// the GPU counts for all the window says it drew anew, which is more.
    pub changed: u64,
}

/// A frame on the GPU that drew it, as a dmabuf of RGBA. It is not drawn over while
/// someone holds it.
#[derive(Clone)]
pub struct GpuBuffer {
    dmabuf: Dmabuf,
    #[allow(dead_code)]
    lease: Arc<()>,
}

/// One plane of a [`GpuBuffer`].
pub struct Plane<'a> {
    pub fd: BorrowedFd<'a>,
    pub offset: u32,
    pub stride: u32,
}

impl GpuBuffer {
    /// The DRM format modifier.
    pub fn layout(&self) -> u64 {
        self.dmabuf.format().modifier.into()
    }

    pub fn planes(&self) -> impl Iterator<Item = Plane<'_>> {
        let places = self.dmabuf.offsets().zip(self.dmabuf.strides());
        self.dmabuf
            .handles()
            .zip(places)
            .map(|(fd, (offset, stride))| Plane { fd, offset, stride })
    }
}

/// Held by one who needs a window's frames as pixels in memory; they come so while it is
/// held.
pub struct Pixels(#[allow(dead_code)] Arc<()>);

/// A window's frames: the latest one, replaced as the window changes, `None` until the window
/// has content. Closed when the window is.
pub type Frames = watch::Receiver<Option<Arc<Frame>>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cursor {
    /// Nothing to show: the pointer has no image, or it is drawn into the frames.
    Hidden,
    /// A CSS cursor name.
    Named(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
    Back,
    Forward,
}

/// Input to a window. Positions are in the window's logical pixels, from the origin of its
/// frame.
#[derive(Debug, Clone)]
pub enum Input {
    PointerMotion {
        window: WindowId,
        x: f64,
        y: f64,
    },
    PointerButton {
        window: WindowId,
        x: f64,
        y: f64,
        button: Button,
        pressed: bool,
    },
    /// `dx` and `dy` are wheel notches.
    PointerScroll {
        window: WindowId,
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    },
    PointerLeave,
    /// A physical key, by its Linux evdev code.
    Key {
        window: WindowId,
        code: u32,
        pressed: bool,
    },
    /// Drops content onto a window, as one who dragged it there would.
    Drop {
        window: WindowId,
        x: f64,
        y: f64,
        content: Forms,
    },
    /// Text as it is. A field that takes text input gets it whole; anything else gets it
    /// typed through the keymap, without the characters no key produces.
    Text {
        window: WindowId,
        text: String,
        /// The text is still being composed, as an input method's is: it shows in the
        /// field as such, in place of what was being composed before, and text that is
        /// not ends the composing.
        composing: bool,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("window {} not found", .0.0)]
    WindowNotFound(WindowId),
    #[error("window {} has no content yet", .0.0)]
    NoContent(WindowId),
    #[error("render failed: {0}")]
    Render(String),
    #[error("the compositor is not running")]
    Gone,
}

/// The compositor, from other threads. It stops when the last handle is dropped.
#[derive(Clone)]
pub struct Handle {
    jobs: channel::Sender<Job>,
    windows: watch::Receiver<Vec<WindowInfo>>,
    cursor: watch::Receiver<Cursor>,
    clipboard: watch::Receiver<Option<Forms>>,
    render_node: Option<PathBuf>,
    started: Instant,
    thread: Arc<Mutex<Option<JoinHandle<()>>>>,
}

/// Starts the compositor and returns once its socket accepts clients.
pub fn start(config: Config) -> anyhow::Result<Handle> {
    let (jobs, jobs_source) = channel::channel::<Job>();
    let (started, starting) = mpsc::channel();
    let clock = Instant::now();
    let thread = std::thread::Builder::new()
        .name("compositor".into())
        .spawn(move || {
            let built = EventLoop::<State>::try_new()
                .map_err(anyhow::Error::from)
                .and_then(|mut event_loop| {
                    let state = State::new(&mut event_loop, &config, jobs_source, clock)?;
                    Ok((event_loop, state))
                });
            let (mut event_loop, mut state) = match built {
                Ok((event_loop, state)) => {
                    let _ = started.send(Ok((
                        state.windows_tx.subscribe(),
                        state.cursor_tx.subscribe(),
                        state.clipboard_tx.subscribe(),
                        state.render_node.clone(),
                    )));
                    (event_loop, state)
                }
                Err(err) => {
                    let _ = started.send(Err(err));
                    return;
                }
            };
            if let Err(err) = event_loop.run(None, &mut state, |_| {}) {
                tracing::error!(%err, "the compositor stopped");
            }
        })?;
    let (windows, cursor, clipboard, render_node) = starting
        .recv()
        .map_err(|_| anyhow::anyhow!("the compositor thread ended while starting"))??;
    Ok(Handle {
        jobs,
        windows,
        cursor,
        clipboard,
        render_node,
        started: clock,
        thread: Arc::new(Mutex::new(Some(thread))),
    })
}

impl Handle {
    /// The windows that have content, bottom to top. The channel closes when the compositor
    /// ends.
    pub fn windows(&self) -> watch::Receiver<Vec<WindowInfo>> {
        self.windows.clone()
    }

    /// The device file of the GPU that draws the windows, which clients are to draw on
    /// too; none when the CPU draws.
    pub fn render_node(&self) -> Option<&Path> {
        self.render_node.as_deref()
    }

    pub fn cursor(&self) -> watch::Receiver<Cursor> {
        self.cursor.clone()
    }

    /// A window is drawn only while someone holds its frames.
    pub async fn frames(&self, window: WindowId) -> Result<Frames, Error> {
        self.call(move |state| state.watch(window)).await?
    }

    /// See [`Pixels`]. The window's next frame comes at once, with them.
    pub async fn pixels(&self, window: WindowId) -> Result<Pixels, Error> {
        self.call(move |state| state.read_back(window)).await?
    }

    pub async fn screenshot(&self, window: WindowId) -> Result<Frame, Error> {
        self.call(move |state| state.screenshot(window)).await?
    }

    /// Ends the compositor and waits until it has: its clients lose their display. A
    /// process is to do this before it exits, as the GPU's driver is torn down with the
    /// process and the compositor must not still be drawing with it then.
    pub fn stop(&self) {
        self.submit(|state| state.stop());
        let thread = self.thread.lock().expect("not poisoned").take();
        if let Some(thread) = thread {
            let _ = thread.join();
        }
    }

    /// What the session's clients last copied; none before they did.
    pub fn clipboard(&self) -> watch::Receiver<Option<Forms>> {
        self.clipboard.clone()
    }

    /// Puts content on the session's clipboard, for its clients to paste.
    pub fn set_clipboard(&self, forms: Forms) {
        self.submit(move |state| state.set_clipboard(forms));
    }

    pub fn input(&self, input: Input) {
        self.submit(move |state| state.input(input));
    }

    /// Raises the window and gives it the keyboard.
    pub fn focus(&self, window: WindowId) {
        self.submit(move |state| {
            if let Ok(window) = state.window(window) {
                state.focus_window(&window);
            }
        });
    }

    /// Tags the next window that opens with `tag`, so whoever is about to make the client
    /// open one can tell it from the others. One window is expected at a time.
    pub fn expect(&self, tag: String) {
        self.submit(move |state| state.expected = Some(tag));
    }

    /// Stops expecting the window tagged `tag`, when it has not opened yet.
    pub fn forget(&self, tag: String) {
        self.submit(move |state| {
            if state.expected.as_ref() == Some(&tag) {
                state.expected = None;
            }
        });
    }

    /// Now, on the clock frames are stamped with.
    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// Draws the pointer into the frames of the window it is over, for those who cannot
    /// draw it themselves, such as a recording. Watchers are told the cursor is hidden
    /// meanwhile, so that none shows it twice.
    pub fn draw_pointer(&self, drawn: bool) {
        self.submit(move |state| state.draw_pointer(drawn));
    }

    /// Gives a window its own viewport, as near to this one as it can be given.
    pub fn set_viewport(&self, window: WindowId, viewport: Viewport) {
        self.submit(move |state| state.set_viewport(window, viewport.bounded()));
    }

    fn submit(&self, job: impl FnOnce(&mut State) + Send + 'static) {
        let _ = self.jobs.send(Box::new(job));
    }

    async fn call<T: Send + 'static>(
        &self,
        job: impl FnOnce(&mut State) -> T + Send + 'static,
    ) -> Result<T, Error> {
        let (reply, answer) = oneshot::channel();
        self.jobs
            .send(Box::new(move |state| {
                let _ = reply.send(job(state));
            }))
            .map_err(|_| Error::Gone)?;
        answer.await.map_err(|_| Error::Gone)
    }
}
