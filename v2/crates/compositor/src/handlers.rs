use smithay::{
    backend::{allocator::dmabuf::Dmabuf, renderer::utils::on_commit_buffer_handler},
    delegate_compositor, delegate_cursor_shape, delegate_data_device, delegate_dmabuf,
    delegate_fractional_scale, delegate_output, delegate_presentation, delegate_primary_selection,
    delegate_seat, delegate_shm, delegate_viewporter, delegate_xdg_decoration, delegate_xdg_shell,
    desktop::{
        PopupKeyboardGrab, PopupKind, PopupPointerGrab, PopupUngrabStrategy, Window,
        find_popup_root_surface, get_popup_toplevel_coords,
    },
    input::{
        Seat, SeatHandler, SeatState,
        pointer::{CursorImageStatus, Focus},
    },
    reexports::{
        wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode,
        wayland_server::{
            Client, Resource,
            protocol::{wl_buffer, wl_output::WlOutput, wl_seat, wl_surface::WlSurface},
        },
    },
    utils::{Rectangle, Serial},
    wayland::{
        buffer::BufferHandler,
        compositor::{
            CompositorClientState, CompositorHandler, CompositorState, get_parent,
            is_sync_subsurface, with_states,
        },
        dmabuf::{DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier},
        fractional_scale::FractionalScaleHandler,
        output::OutputHandler,
        selection::{
            SelectionHandler, SelectionSource, SelectionTarget,
            data_device::{
                ClientDndGrabHandler, DataDeviceHandler, DataDeviceState, ServerDndGrabHandler,
                set_data_device_focus,
            },
            primary_selection::{PrimarySelectionHandler, PrimarySelectionState},
        },
        shell::xdg::{
            Configure, PopupSurface, PositionerState, ToplevelSurface, XdgShellHandler,
            XdgShellState, XdgToplevelSurfaceData, decoration::XdgDecorationHandler,
        },
        shm::{ShmHandler, ShmState},
        tablet_manager::TabletSeatHandler,
    },
};
use std::{fs::File, io::Write, os::fd::OwnedFd, sync::Arc};
use tracing::info;

use crate::state::{
    ClientState, Shown, State, TEXT_FORMS, Tag, configure_when_ready, tell_scale, window_id,
};

impl CompositorHandler for State {
    fn compositor_state(&mut self) -> &mut CompositorState {
        &mut self.compositor_state
    }

    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
        &client
            .get_data::<ClientState>()
            .expect("every client is inserted with ClientState")
            .compositor_state
    }

    fn new_surface(&mut self, surface: &WlSurface) {
        // What it belongs to is not known yet; `commit` tells it again once it is.
        with_states(surface, |states| {
            tell_scale(surface, states, self.viewport.scale)
        });
    }

    fn commit(&mut self, surface: &WlSurface) {
        on_commit_buffer_handler::<Self>(surface);
        let scale = self.scale_for_surface(surface);
        with_states(surface, |states| tell_scale(surface, states, scale));

        if !is_sync_subsurface(surface) {
            let mut root = surface.clone();
            while let Some(parent) = get_parent(&root) {
                root = parent;
            }
            if let Some(window) = self.window_for_surface(&root) {
                window.on_commit();
                // A window takes the keyboard once it has content. Given it earlier, the
                // client would not take it for a window it has yet to show, and would not
                // be given it again.
                let shown = window.geometry().size;
                if shown.w > 0 && shown.h > 0 && window.user_data().insert_if_missing(|| Shown) {
                    self.focus_window(&window);
                }
            }
        }

        if let Some(window) = self.window_for_surface(surface) {
            let initial_configure_sent = with_states(surface, |states| {
                states
                    .data_map
                    .get::<XdgToplevelSurfaceData>()
                    .and_then(|data| data.lock().ok().map(|data| data.initial_configure_sent))
                    .unwrap_or(true)
            });
            if !initial_configure_sent && let Some(toplevel) = window.toplevel() {
                // By now the client has said whether the window has a parent.
                self.fill_viewport(toplevel);
                toplevel.send_configure();
            }
        }

        self.popups.commit(surface);
        if let Some(PopupKind::Xdg(popup)) = self.popups.find_popup(surface)
            && !popup.is_initial_configure_sent()
        {
            // The initial configure is always allowed.
            let _ = popup.send_configure();
        }
    }
}

impl BufferHandler for State {
    fn buffer_destroyed(&mut self, _buffer: &wl_buffer::WlBuffer) {}
}

impl ShmHandler for State {
    fn shm_state(&self) -> &ShmState {
        &self.shm_state
    }
}

impl XdgShellHandler for State {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg_shell_state
    }

    /// The client took the configure in flight: the size it is owed, if changed since, goes
    /// out. Not on commit: a configure that changes nothing may never get one.
    fn ack_configure(&mut self, surface: WlSurface, configure: Configure) {
        if let Configure::Toplevel(_) = configure
            && let Some(window) = self.window_for_surface(&surface)
            && let Some(toplevel) = window.toplevel()
        {
            configure_when_ready(toplevel);
        }
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        let id = self.allocate_window_id();
        let window = Window::new_wayland_window(surface);
        window.user_data().insert_if_missing(|| id);
        if let Some(tag) = self.expected.take() {
            window.user_data().insert_if_missing(|| Tag(tag));
        }
        self.space.map_element(window, (0, 0), false);
        info!(id = id.0, "window opened");
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        if let Some(window) = self.window_for_surface(surface.wl_surface()) {
            info!(id = ?window_id(&window).map(|id| id.0), "window closed");
            if let Some(id) = window_id(&window) {
                self.forget_viewport(id);
            }
            self.space.unmap_elem(&window);
            // The keyboard goes to the window below.
            let below = self.space.elements().next_back().cloned();
            if let Some(below) = below {
                self.focus_window(&below);
            }
        }
    }

    fn new_popup(&mut self, surface: PopupSurface, _positioner: PositionerState) {
        self.unconstrain_popup(&surface);
        let _ = self.popups.track_popup(PopupKind::Xdg(surface));
    }

    fn reposition_request(
        &mut self,
        surface: PopupSurface,
        positioner: PositionerState,
        token: u32,
    ) {
        surface.with_pending_state(|state| {
            state.geometry = positioner.get_geometry();
            state.positioner = positioner;
        });
        self.unconstrain_popup(&surface);
        surface.send_repositioned(token);
    }

    fn grab(&mut self, surface: PopupSurface, seat: wl_seat::WlSeat, serial: Serial) {
        let Some(seat) = Seat::<Self>::from_resource(&seat) else {
            return;
        };
        let kind = PopupKind::Xdg(surface);
        let Some(root) = find_popup_root_surface(&kind)
            .ok()
            .filter(|root| self.window_for_surface(root).is_some())
        else {
            return;
        };
        let Ok(mut grab) = self.popups.grab_popup(root, kind, &seat, serial) else {
            return;
        };

        if let Some(keyboard) = seat.get_keyboard() {
            if keyboard.is_grabbed()
                && !(keyboard.has_grab(serial)
                    || keyboard.has_grab(grab.previous_serial().unwrap_or(serial)))
            {
                grab.ungrab(PopupUngrabStrategy::All);
                return;
            }
            keyboard.set_focus(self, grab.current_grab(), serial);
            keyboard.set_grab(self, PopupKeyboardGrab::new(&grab), serial);
        }
        if let Some(pointer) = seat.get_pointer() {
            if pointer.is_grabbed()
                && !(pointer.has_grab(serial)
                    || pointer.has_grab(grab.previous_serial().unwrap_or_else(|| grab.serial())))
            {
                grab.ungrab(PopupUngrabStrategy::All);
                return;
            }
            pointer.set_grab(self, PopupPointerGrab::new(&grab), serial, Focus::Keep);
        }
    }

    /// Windows stay fullscreen at the viewport whatever they ask for; the answer keeps
    /// their state, as the protocol requires.
    fn maximize_request(&mut self, surface: ToplevelSurface) {
        keep_state(&surface);
    }

    fn unmaximize_request(&mut self, surface: ToplevelSurface) {
        keep_state(&surface);
    }

    fn fullscreen_request(&mut self, surface: ToplevelSurface, _output: Option<WlOutput>) {
        keep_state(&surface);
    }

    fn unfullscreen_request(&mut self, surface: ToplevelSurface) {
        keep_state(&surface);
    }
}

fn keep_state(surface: &ToplevelSurface) {
    if surface.is_initial_configure_sent() {
        surface.send_configure();
    }
}

impl State {
    /// Popups may extend right and down past the window, never left or up, so the window's
    /// geometry origin stays the origin of its frame and input coordinates.
    fn unconstrain_popup(&self, popup: &PopupSurface) {
        let kind = PopupKind::Xdg(popup.clone());
        let Ok(root) = find_popup_root_surface(&kind) else {
            return;
        };
        let Some(window) = self.window_for_surface(&root) else {
            return;
        };
        let viewport = self.viewport_of(&window);
        let mut target =
            Rectangle::from_size((viewport.width as i32, viewport.height as i32).into());
        target.loc -= get_popup_toplevel_coords(&kind);
        popup.with_pending_state(|state| {
            state.geometry = state.positioner.get_unconstrained_geometry(target);
        });
    }
}

/// The session draws no title bars, and windows should not either: they are asked to leave
/// decorations to the server, which then draws none.
fn prefer_server_side(toplevel: &ToplevelSurface) {
    toplevel.with_pending_state(|state| state.decoration_mode = Some(Mode::ServerSide));
    if toplevel.is_initial_configure_sent() {
        configure_when_ready(toplevel);
    }
}

impl XdgDecorationHandler for State {
    fn new_decoration(&mut self, toplevel: ToplevelSurface) {
        prefer_server_side(&toplevel);
    }

    fn request_mode(&mut self, toplevel: ToplevelSurface, _mode: Mode) {
        prefer_server_side(&toplevel);
    }

    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        prefer_server_side(&toplevel);
    }
}

impl SeatHandler for State {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<Self> {
        &mut self.seat_state
    }

    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&WlSurface>) {
        let client = focused.and_then(|surface| self.display_handle.get_client(surface.id()).ok());
        set_data_device_focus(&self.display_handle, seat, client);
        if let Some(focused) = focused {
            self.text_input.focus(focused);
        }
    }

    fn cursor_image(&mut self, _seat: &Seat<Self>, image: CursorImageStatus) {
        self.set_cursor(image);
    }
}

impl TabletSeatHandler for State {}

impl SelectionHandler for State {
    /// The text the compositor put on the clipboard.
    type SelectionUserData = Arc<str>;

    fn new_selection(
        &mut self,
        target: SelectionTarget,
        source: Option<SelectionSource>,
        _seat: Seat<Self>,
    ) {
        if target != SelectionTarget::Clipboard {
            return;
        }
        let Some(source) = source else {
            return;
        };
        let offered = source.mime_types();
        let form = TEXT_FORMS
            .iter()
            .find(|form| offered.iter().any(|offered| offered == *form));
        if let Some(form) = form {
            let form = (*form).to_owned();
            // The selection is the client's only once this returns.
            self.idle
                .insert_idle(move |state| state.read_clipboard(form));
        }
    }

    fn send_selection(
        &mut self,
        _target: SelectionTarget,
        _form: String,
        fd: OwnedFd,
        _seat: Seat<Self>,
        text: &Arc<str>,
    ) {
        let text = text.clone();
        // The client reads when it gets to it.
        std::thread::spawn(move || {
            let _ = File::from(fd).write_all(text.as_bytes());
        });
    }
}

impl DataDeviceHandler for State {
    fn data_device_state(&self) -> &DataDeviceState {
        &self.data_device_state
    }
}

impl ClientDndGrabHandler for State {}
impl ServerDndGrabHandler for State {}

impl PrimarySelectionHandler for State {
    fn primary_selection_state(&self) -> &PrimarySelectionState {
        &self.primary_selection_state
    }
}

impl OutputHandler for State {}

delegate_compositor!(State);
delegate_shm!(State);
delegate_xdg_shell!(State);
delegate_xdg_decoration!(State);
delegate_seat!(State);
delegate_data_device!(State);
delegate_primary_selection!(State);
delegate_output!(State);
delegate_cursor_shape!(State);
delegate_viewporter!(State);
delegate_presentation!(State);

impl FractionalScaleHandler for State {
    fn new_fractional_scale(&mut self, surface: WlSurface) {
        let scale = self.scale_for_surface(&surface);
        with_states(&surface, |states| tell_scale(&surface, states, scale));
    }
}

delegate_fractional_scale!(State);

impl DmabufHandler for State {
    fn dmabuf_state(&mut self) -> &mut DmabufState {
        &mut self.dmabuf_state
    }

    fn dmabuf_imported(
        &mut self,
        _global: &DmabufGlobal,
        dmabuf: Dmabuf,
        notifier: ImportNotifier,
    ) {
        if self.renderer.import_dmabuf(&dmabuf) {
            let _ = notifier.successful::<State>();
        } else {
            notifier.failed();
        }
    }
}

delegate_dmabuf!(State);
