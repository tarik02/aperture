use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Context;
use smithay::{
    backend::renderer::pixman::PixmanRenderer,
    desktop::{PopupManager, Space, Window, utils::OutputPresentationFeedback},
    input::{Seat, SeatState, keyboard::XkbConfig, pointer::CursorImageStatus},
    output::{Mode, Output, PhysicalProperties, Subpixel},
    reexports::{
        calloop::{
            EventLoop, Interest, LoopSignal, PostAction,
            channel::{self, Event},
            generic::Generic,
            timer::{TimeoutAction, Timer},
        },
        wayland_protocols::{
            wp::presentation_time::server::wp_presentation_feedback,
            xdg::shell::server::xdg_toplevel,
        },
        wayland_server::{
            Display, DisplayHandle, ListeningSocket,
            backend::{self, ClientData, DisconnectReason},
            protocol::wl_surface::WlSurface,
        },
    },
    utils::{Clock, Monotonic, SERIAL_COUNTER, Transform},
    wayland::{
        compositor::{CompositorClientState, CompositorState, with_states},
        cursor_shape::CursorShapeManagerState,
        output::OutputManagerState,
        presentation::{PresentationState, Refresh},
        selection::{data_device::DataDeviceState, primary_selection::PrimarySelectionState},
        shell::xdg::{
            ToplevelSurface, XdgShellState, XdgToplevelSurfaceData, decoration::XdgDecorationState,
        },
        shm::ShmState,
        viewporter::ViewporterState,
    },
};
use tokio::sync::watch;
use tracing::{info, warn};

use crate::{
    Config, Cursor, Error, Frame, Frames, Viewport, WindowId, WindowInfo, keymap::KeyTable,
    render::WindowFrame,
};

/// Windows are told to draw, and drawn, this often.
const REFRESH: i32 = 60_000;
const FRAME_INTERVAL: Duration = Duration::from_nanos(1_000_000_000_000 / REFRESH as u64);

/// Work executed on the compositor thread, which owns all Wayland state.
pub type Job = Box<dyn FnOnce(&mut State) + Send>;

/// A window someone watches: its image, and where its frames go.
struct Watched {
    frame: Option<WindowFrame>,
    frames: watch::Sender<Option<Arc<Frame>>>,
}

pub struct State {
    start: Instant,
    pub display_handle: DisplayHandle,
    stop: LoopSignal,

    /// Every window is mapped at the origin: windows have no shared screen, the space only
    /// tracks stacking and activation.
    pub space: Space<Window>,
    pub popups: PopupManager,
    pub output: Output,
    renderer: PixmanRenderer,
    pub key_table: KeyTable,
    pub viewport: Viewport,
    watched: HashMap<WindowId, Watched>,
    pub windows_tx: watch::Sender<Vec<WindowInfo>>,
    pub cursor_tx: watch::Sender<Cursor>,
    next_window_id: u32,
    /// Frames presented, which clients compare against the refresh rate.
    presented: u64,
    /// The clock presentation feedback reports times in.
    clock: Clock<Monotonic>,

    pub compositor_state: CompositorState,
    pub xdg_shell_state: XdgShellState,
    pub shm_state: ShmState,
    pub seat_state: SeatState<State>,
    pub data_device_state: DataDeviceState,
    pub primary_selection_state: PrimarySelectionState,
    pub seat: Seat<Self>,
    _output_manager_state: OutputManagerState,
    _cursor_shape_state: CursorShapeManagerState,
    _viewporter_state: ViewporterState,
    _presentation_state: PresentationState,
    _decoration_state: XdgDecorationState,
}

impl State {
    pub fn new(
        event_loop: &mut EventLoop<Self>,
        config: &Config,
        jobs: channel::Channel<Job>,
    ) -> anyhow::Result<Self> {
        let display: Display<Self> = Display::new()?;
        let dh = display.handle();

        let compositor_state = CompositorState::new::<Self>(&dh);
        let xdg_shell_state = XdgShellState::new::<Self>(&dh);
        let shm_state = ShmState::new::<Self>(&dh, vec![]);
        let output_manager_state = OutputManagerState::new_with_xdg_output::<Self>(&dh);
        let data_device_state = DataDeviceState::new::<Self>(&dh);
        let primary_selection_state = PrimarySelectionState::new::<Self>(&dh);
        let cursor_shape_state = CursorShapeManagerState::new::<Self>(&dh);
        let viewporter_state = ViewporterState::new::<Self>(&dh);
        let clock = Clock::<Monotonic>::new();
        let presentation_state = PresentationState::new::<Self>(&dh, clock.id() as u32);
        let decoration_state = XdgDecorationState::new::<Self>(&dh);

        let mut seat_state = SeatState::new();
        let mut seat = seat_state.new_wl_seat(&dh, "aperture");
        // Layouts come from XKB_DEFAULT_LAYOUT etc., e.g. `us,ua`.
        seat.add_keyboard(XkbConfig::default(), 200, 25)
            .context("failed to create the keyboard")?;
        seat.add_pointer();

        let output = Output::new(
            "aperture-0".into(),
            PhysicalProperties {
                size: (0, 0).into(),
                subpixel: Subpixel::Unknown,
                make: "aperture".into(),
                model: "virtual".into(),
            },
        );
        output.create_global::<Self>(&dh);
        let mut space = Space::default();
        space.map_output(&output, (0, 0));

        let handle = event_loop.handle();
        let socket = ListeningSocket::bind_absolute(config.socket.clone())
            .with_context(|| format!("failed to bind {}", config.socket.display()))?;
        handle
            .insert_source(
                Generic::new(
                    socket,
                    Interest::READ,
                    smithay::reexports::calloop::Mode::Level,
                ),
                |_, socket, state: &mut Self| {
                    while let Some(stream) = socket.accept()? {
                        if let Err(err) = state
                            .display_handle
                            .insert_client(stream, Arc::new(ClientState::default()))
                        {
                            warn!(?err, "failed to insert a client");
                        }
                    }
                    Ok(PostAction::Continue)
                },
            )
            .map_err(|err| anyhow::anyhow!("failed to insert the socket source: {err}"))?;
        handle
            .insert_source(
                Generic::new(
                    display,
                    Interest::READ,
                    smithay::reexports::calloop::Mode::Level,
                ),
                |_, display, state| {
                    // Safety: the display is never dropped while the source is alive.
                    unsafe {
                        display.get_mut().dispatch_clients(state)?;
                    }
                    Ok(PostAction::Continue)
                },
            )
            .map_err(|err| anyhow::anyhow!("failed to insert the display source: {err}"))?;
        handle
            .insert_source(jobs, |event, (), state| match event {
                Event::Msg(job) => {
                    job(state);
                    let _ = state.display_handle.flush_clients();
                }
                // Every handle is gone.
                Event::Closed => state.stop.stop(),
            })
            .map_err(|err| anyhow::anyhow!("failed to insert the job source: {err}"))?;
        // Without a real output nothing paces clients, so frames are driven by a timer.
        // Deadlines follow each other, not the end of the work, so the rate does not drift;
        // after a stall the timer resumes from now instead of catching up.
        handle
            .insert_source(Timer::immediate(), |deadline, (), state| {
                state.tick();
                TimeoutAction::ToInstant((deadline + FRAME_INTERVAL).max(Instant::now()))
            })
            .map_err(|err| anyhow::anyhow!("failed to insert the frame timer: {err}"))?;

        let mut state = Self {
            start: Instant::now(),
            display_handle: dh,
            stop: event_loop.get_signal(),
            space,
            popups: PopupManager::default(),
            output,
            renderer: PixmanRenderer::new().context("failed to create the pixman renderer")?,
            key_table: KeyTable::default(),
            viewport: config.viewport,
            watched: HashMap::new(),
            windows_tx: watch::Sender::new(Vec::new()),
            cursor_tx: watch::Sender::new(Cursor::Named("default")),
            next_window_id: 1,
            presented: 0,
            clock,
            compositor_state,
            xdg_shell_state,
            shm_state,
            seat_state,
            data_device_state,
            primary_selection_state,
            seat,
            _output_manager_state: output_manager_state,
            _cursor_shape_state: cursor_shape_state,
            _viewporter_state: viewporter_state,
            _presentation_state: presentation_state,
            _decoration_state: decoration_state,
        };
        state.apply_output_mode();
        let keyboard = state.seat.get_keyboard().expect("seat has a keyboard");
        state.key_table = keyboard.with_xkb_state(&mut state, |context| {
            KeyTable::build(&context.xkb().lock().unwrap())
        });
        info!(socket = %config.socket.display(), "compositor running");
        Ok(state)
    }

    pub fn time_msec(&self) -> u32 {
        self.start.elapsed().as_millis() as u32
    }

    pub fn allocate_window_id(&mut self) -> WindowId {
        let id = WindowId(self.next_window_id);
        self.next_window_id += 1;
        id
    }

    pub fn window(&self, id: WindowId) -> Result<Window, Error> {
        self.space
            .elements()
            .find(|window| window_id(window) == Some(id))
            .cloned()
            .ok_or(Error::WindowNotFound(id))
    }

    pub fn window_for_surface(&self, surface: &WlSurface) -> Option<Window> {
        self.space
            .elements()
            .find(|window| window.toplevel().is_some_and(|t| t.wl_surface() == surface))
            .cloned()
    }

    /// The output is as large as the viewport: clients look at it for popup constraints and
    /// size hints only.
    fn apply_output_mode(&mut self) {
        let mode = Mode {
            size: (self.viewport.width as i32, self.viewport.height as i32).into(),
            refresh: REFRESH,
        };
        let previous = self.output.current_mode();
        self.output.change_current_state(
            Some(mode),
            Some(Transform::Normal),
            None,
            Some((0, 0).into()),
        );
        self.output.set_preferred(mode);
        if let Some(previous) = previous
            && previous != mode
        {
            self.output.delete_mode(previous);
        }
    }

    pub fn set_viewport(&mut self, viewport: Viewport) {
        if viewport == self.viewport || viewport.width == 0 || viewport.height == 0 {
            return;
        }
        self.viewport = viewport;
        self.apply_output_mode();
        for window in self.space.elements() {
            if let Some(toplevel) = window.toplevel() {
                self.fill_viewport(toplevel);
                configure_when_ready(toplevel);
            }
        }
    }

    /// Gives a window without a parent the whole viewport, as a fullscreen window: the
    /// browser then draws the page and nothing of its own around it, so the viewport is the
    /// page's. Dialogs keep the size they ask for.
    pub fn fill_viewport(&self, toplevel: &ToplevelSurface) {
        if toplevel.parent().is_some() {
            return;
        }
        let size = (self.viewport.width as i32, self.viewport.height as i32);
        toplevel.with_pending_state(|state| {
            state.size = Some(size.into());
            state.states.set(xdg_toplevel::State::Fullscreen);
        });
    }

    pub fn watch(&mut self, id: WindowId) -> Result<Frames, Error> {
        self.window(id)?;
        let watched = self.watched.entry(id).or_insert_with(|| Watched {
            frame: None,
            frames: watch::Sender::new(None),
        });
        // Nobody watched for a while: what the channel holds is out of date.
        if watched.frames.receiver_count() == 0 {
            watched.frame = None;
            watched.frames.send_replace(None);
        }
        Ok(watched.frames.subscribe())
    }

    pub fn screenshot(&mut self, id: WindowId) -> Result<Frame, Error> {
        let window = self.window(id)?;
        let mut frame = None;
        WindowFrame::render(&mut frame, &mut self.renderer, &window)?;
        let frame = frame.ok_or(Error::NoContent(id))?;
        let (width, height) = frame.size();
        Ok(Frame {
            width,
            height,
            rgba: frame.pixels().to_vec(),
            time: self.start.elapsed(),
        })
    }

    /// One frame of every window: tells the windows to draw their next, reports their last
    /// as presented, and hands the watched ones that changed to their watchers.
    fn tick(&mut self) {
        let time = self.start.elapsed();
        let windows: Vec<(Window, WindowId)> = self
            .space
            .elements()
            .filter_map(|window| Some((window.clone(), window_id(window)?)))
            .collect();

        // Clients such as Chromium pace themselves by presentation feedback rather than
        // frame callbacks, and assume 60 Hz without it.
        self.presented += 1;
        let now = self.clock.now();
        for (window, _) in &windows {
            let output = &self.output;
            window.send_frame(output, time, Some(FRAME_INTERVAL), |_, _| {
                Some(output.clone())
            });
            let mut feedback = OutputPresentationFeedback::new(output);
            window.take_presentation_feedback(
                &mut feedback,
                |_, _| Some(output.clone()),
                |_, _| wp_presentation_feedback::Kind::empty(),
            );
            feedback.presented(
                now,
                Refresh::Fixed(FRAME_INTERVAL),
                self.presented,
                wp_presentation_feedback::Kind::Vsync,
            );
        }

        self.watched
            .retain(|id, _| windows.iter().any(|(_, window)| window == id));
        for (window, id) in &windows {
            let Some(watched) = self.watched.get_mut(id) else {
                continue;
            };
            if watched.frames.receiver_count() == 0 {
                continue;
            }
            match WindowFrame::render(&mut watched.frame, &mut self.renderer, window) {
                Ok(true) => {
                    if let Some(frame) = &watched.frame {
                        let (width, height) = frame.size();
                        watched.frames.send_replace(Some(Arc::new(Frame {
                            width,
                            height,
                            rgba: frame.pixels().to_vec(),
                            time,
                        })));
                    }
                }
                Ok(false) => {}
                Err(err) => warn!(id = id.0, %err, "failed to render a window"),
            }
        }

        self.announce_windows();
        self.popups.cleanup();
        self.space.refresh();
        let _ = self.display_handle.flush_clients();
    }

    fn announce_windows(&mut self) {
        let windows: Vec<WindowInfo> = self
            .space
            .elements()
            .filter_map(|window| self.window_info(window))
            .filter(|info| info.width > 0 && info.height > 0)
            .collect();
        self.windows_tx.send_if_modified(|announced| {
            let changed = *announced != windows;
            if changed {
                *announced = windows;
            }
            changed
        });
    }

    fn window_info(&self, window: &Window) -> Option<WindowInfo> {
        let id = window_id(window)?;
        let toplevel = window.toplevel()?;
        let (title, app_id) = with_states(toplevel.wl_surface(), |states| {
            let data = states
                .data_map
                .get::<XdgToplevelSurfaceData>()?
                .lock()
                .ok()?;
            Some((data.title.clone(), data.app_id.clone()))
        })?;
        let parent = toplevel
            .parent()
            .and_then(|parent| self.window_for_surface(&parent))
            .and_then(|parent| window_id(&parent));
        let geometry = window.geometry();
        Some(WindowInfo {
            id,
            parent,
            title: title.unwrap_or_default(),
            app_id: app_id.unwrap_or_default(),
            width: geometry.size.w.max(0).unsigned_abs(),
            height: geometry.size.h.max(0).unsigned_abs(),
        })
    }

    pub fn set_cursor(&mut self, status: CursorImageStatus) {
        let cursor = match status {
            CursorImageStatus::Hidden => Cursor::Hidden,
            CursorImageStatus::Named(icon) => Cursor::Named(icon.name()),
            // A cursor the client draws itself, such as a page's own image.
            CursorImageStatus::Surface(_) => Cursor::Named("default"),
        };
        self.cursor_tx.send_if_modified(|announced| {
            let changed = *announced != cursor;
            if changed {
                *announced = cursor;
            }
            changed
        });
    }

    /// A window that just opened takes the keyboard.
    pub fn focus_new(&mut self, window: &Window) {
        if let Some(toplevel) = window.toplevel() {
            let keyboard = self.seat.get_keyboard().expect("seat has a keyboard");
            if !keyboard.is_grabbed() {
                self.space.raise_element(window, true);
                keyboard.set_focus(
                    self,
                    Some(toplevel.wl_surface().clone()),
                    SERIAL_COUNTER.next_serial(),
                );
            }
        }
    }
}

pub fn window_id(window: &Window) -> Option<WindowId> {
    window.user_data().get::<WindowId>().copied()
}

#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: backend::ClientId) {}
    fn disconnected(&self, _client_id: backend::ClientId, _reason: DisconnectReason) {}
}

/// Sends a toplevel its pending state, unless it has yet to acknowledge the last configure;
/// the acknowledgement sends it then (see `XdgShellHandler::ack_configure`). A client slower
/// than the changes thus gets the latest size instead of working through every one in between.
pub fn configure_when_ready(toplevel: &ToplevelSurface) {
    let waiting = with_states(toplevel.wl_surface(), |states| {
        states
            .data_map
            .get::<XdgToplevelSurfaceData>()
            .and_then(|data| {
                data.lock()
                    .ok()
                    .map(|data| !data.pending_configures().is_empty())
            })
            .unwrap_or(false)
    });
    if !waiting {
        toplevel.send_pending_configure();
    }
}
