//! Text for the fields of clients, as text rather than keys (`zwp_text_input_v3`).
//!
//! The compositor is the input method itself: what it is given to enter goes to the field
//! that takes text in the window with the keyboard. Smithay's own text input only passes
//! fields on to an input method that is a client, and there is none here.

use smithay::reexports::{
    wayland_protocols::wp::text_input::zv3::server::{
        zwp_text_input_manager_v3::{self, ZwpTextInputManagerV3},
        zwp_text_input_v3::{self, ZwpTextInputV3},
    },
    wayland_server::{
        Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource,
        backend::ClientId, protocol::wl_surface::WlSurface,
    },
};

use crate::state::State;

/// A client's way to its text fields; it has one for all of them.
struct Field {
    object: ZwpTextInputV3,
    /// What the client asked for and has yet to commit.
    enable: Option<bool>,
    /// A field of the client takes text.
    enabled: bool,
    /// How many times the client committed, which what it is sent refers to.
    commits: u32,
}

#[derive(Default)]
pub struct TextInput {
    fields: Vec<Field>,
    /// The surface with the keyboard.
    focus: Option<WlSurface>,
}

impl TextInput {
    pub fn start(display: &DisplayHandle) {
        display.create_global::<State, ZwpTextInputManagerV3, ()>(1, ());
    }

    /// The keyboard went to `surface`.
    pub fn focus(&mut self, surface: &WlSurface) {
        if self.focus.as_ref() == Some(surface) {
            return;
        }
        if let Some(left) = self.focus.take().filter(Resource::is_alive) {
            for field in self.of(&left) {
                field.object.leave(&left);
                field.enabled = false;
                field.enable = None;
            }
        }
        for field in self.of(surface) {
            field.object.enter(surface);
        }
        self.focus = Some(surface.clone());
    }

    fn of<'a>(&'a mut self, surface: &WlSurface) -> impl Iterator<Item = &'a mut Field> {
        let surface = surface.id();
        self.fields
            .iter_mut()
            .filter(move |field| field.object.id().same_client_as(&surface))
    }

    /// Gives text to the field that takes text in the surface with the keyboard: as
    /// written, or as still being composed, which replaces what was being composed
    /// before. Tells whether there is such a field.
    pub fn enter(&mut self, text: &str, composing: bool) -> bool {
        let Some(focus) = self.focus.clone().filter(Resource::is_alive) else {
            return false;
        };
        let Some(field) = self.of(&focus).find(|field| field.enabled) else {
            return false;
        };
        if composing {
            let end = text.len() as i32;
            field.object.preedit_string(Some(text.to_owned()), end, end);
        } else if !text.is_empty() {
            field.object.commit_string(Some(text.to_owned()));
        }
        // What was being composed goes with anything that is not composing, nothing too.
        field.object.done(field.commits);
        true
    }
}

impl GlobalDispatch<ZwpTextInputManagerV3, ()> for State {
    fn bind(
        _state: &mut Self,
        _display: &DisplayHandle,
        _client: &Client,
        resource: New<ZwpTextInputManagerV3>,
        (): &(),
        data_init: &mut DataInit<'_, Self>,
    ) {
        data_init.init(resource, ());
    }
}

impl Dispatch<ZwpTextInputManagerV3, ()> for State {
    fn request(
        state: &mut Self,
        _client: &Client,
        _manager: &ZwpTextInputManagerV3,
        request: zwp_text_input_manager_v3::Request,
        (): &(),
        _display: &DisplayHandle,
        data_init: &mut DataInit<'_, Self>,
    ) {
        if let zwp_text_input_manager_v3::Request::GetTextInput { id, .. } = request {
            let object = data_init.init(id, ());
            let focus = state.text_input.focus.as_ref();
            if let Some(focus) = focus.filter(|focus| focus.id().same_client_as(&object.id())) {
                object.enter(focus);
            }
            state.text_input.fields.push(Field {
                object,
                enable: None,
                enabled: false,
                commits: 0,
            });
        }
    }
}

impl Dispatch<ZwpTextInputV3, ()> for State {
    fn request(
        state: &mut Self,
        _client: &Client,
        object: &ZwpTextInputV3,
        request: zwp_text_input_v3::Request,
        (): &(),
        _display: &DisplayHandle,
        _data_init: &mut DataInit<'_, Self>,
    ) {
        let fields = &mut state.text_input.fields;
        let Some(field) = fields.iter_mut().find(|field| field.object == *object) else {
            return;
        };
        match request {
            zwp_text_input_v3::Request::Enable => field.enable = Some(true),
            zwp_text_input_v3::Request::Disable => field.enable = Some(false),
            zwp_text_input_v3::Request::Commit => {
                field.commits = field.commits.wrapping_add(1);
                if let Some(enable) = field.enable.take() {
                    field.enabled = enable;
                }
            }
            // Where the field is and what is in it: nothing here shows or completes text.
            _ => {}
        }
    }

    fn destroyed(state: &mut Self, _client: ClientId, object: &ZwpTextInputV3, (): &()) {
        state
            .text_input
            .fields
            .retain(|field| field.object != *object);
    }
}
