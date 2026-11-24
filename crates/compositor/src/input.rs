use smithay::{
    backend::input::{Axis, AxisSource, ButtonState, KeyState},
    desktop::{Window, WindowSurfaceType},
    input::{
        keyboard::{FilterResult, KeyboardHandle, Keycode, Keysym, xkb},
        pointer::{
            AxisFrame, ButtonEvent, GrabStartData as PointerGrabStartData, MotionEvent,
            PointerHandle,
        },
    },
    reexports::{
        calloop::timer::{TimeoutAction, Timer},
        wayland_server::protocol::wl_data_device_manager::DndAction,
    },
    utils::{Logical, Point, SERIAL_COUNTER},
    wayland::selection::data_device::{SourceMetadata, start_dnd},
};

use crate::{
    Button, Input, data,
    keymap::KeyPosition,
    render::frame_rect,
    state::{State, window_id},
};

/// Wheel distance of one notch, matching libinput's convention.
const SCROLL_STEP: f64 = 15.0;

/// Linux evdev codes are offset by 8 in XKB.
const EVDEV_XKB_OFFSET: u32 = 8;

/// How long a window has to say whether it takes what is dragged over it.
const DROP_WITHIN: std::time::Duration = std::time::Duration::from_millis(1500);

fn button_code(button: Button) -> u32 {
    match button {
        Button::Left => 0x110,
        Button::Right => 0x111,
        Button::Middle => 0x112,
        Button::Forward => 0x115,
        Button::Back => 0x116,
    }
}

impl State {
    /// Input to a window that is gone by now is dropped.
    pub fn input(&mut self, input: Input) {
        match input {
            Input::PointerMotion { window, x, y } => {
                if let Ok(window) = self.window(window) {
                    self.pointer_motion(&window, (x, y).into());
                }
            }
            Input::PointerButton {
                window,
                x,
                y,
                button,
                pressed,
            } => {
                let Ok(window) = self.window(window) else {
                    return;
                };
                self.pointer_motion(&window, (x, y).into());
                // The button goes first so that an open popup grab can be dismissed before
                // focusing.
                let state = if pressed {
                    ButtonState::Pressed
                } else {
                    ButtonState::Released
                };
                let pointer = self.pointer();
                pointer.button(
                    self,
                    &ButtonEvent {
                        button: button_code(button),
                        state,
                        serial: SERIAL_COUNTER.next_serial(),
                        time: self.time_msec(),
                    },
                );
                pointer.frame(self);
                if pressed {
                    self.focus_window(&window);
                }
            }
            Input::PointerScroll {
                window,
                x,
                y,
                dx,
                dy,
            } => {
                let Ok(window) = self.window(window) else {
                    return;
                };
                self.pointer_motion(&window, (x, y).into());
                let mut frame = AxisFrame::new(self.time_msec()).source(AxisSource::Wheel);
                for (axis, notches) in [(Axis::Horizontal, dx), (Axis::Vertical, dy)] {
                    if notches != 0.0 {
                        frame = frame
                            .value(axis, notches * SCROLL_STEP)
                            .v120(axis, (notches * 120.0) as i32);
                    }
                }
                let pointer = self.pointer();
                pointer.axis(self, frame);
                pointer.frame(self);
            }
            Input::Drop {
                window,
                x,
                y,
                content,
            } => {
                let Ok(window) = self.window(window) else {
                    return;
                };
                // One thing is dragged at a time.
                if self.drop_held {
                    return;
                }
                self.focus_window(&window);
                let pointer = self.pointer();
                let start = PointerGrabStartData {
                    focus: None,
                    button: button_code(Button::Left),
                    location: pointer.current_location(),
                };
                let source = SourceMetadata {
                    mime_types: data::offered(&content),
                    dnd_action: DndAction::Copy,
                };
                self.dropping = Some(content);
                self.drop_held = true;
                let display = self.display_handle.clone();
                let seat = self.seat.clone();
                let serial = SERIAL_COUNTER.next_serial();
                start_dnd(&display, &seat, self, serial, Some(start), None, source);
                // The window learns of the drag as it comes over it, and says whether it
                // takes it: see `ServerDndGrabHandler`. One that says nothing gets it
                // dropped all the same, which ends the drag.
                self.pointer_motion(&window, (x, y).into());
                let waited = Timer::from_duration(DROP_WITHIN);
                let _ = self.idle.insert_source(waited, |_, (), state| {
                    state.drop_dragged();
                    TimeoutAction::Drop
                });
            }
            Input::PointerLeave => {
                self.pointer_window = None;
                let pointer = self.pointer();
                let location = pointer.current_location();
                pointer.motion(
                    self,
                    None,
                    &MotionEvent {
                        location,
                        serial: SERIAL_COUNTER.next_serial(),
                        time: self.time_msec(),
                    },
                );
                pointer.frame(self);
            }
            Input::Key {
                window,
                code,
                pressed,
            } => {
                // A key comes up wherever the keyboard is by then: the window it went down
                // in may be gone, as after Control and W, and it would stay down otherwise.
                let state = if pressed {
                    let Ok(window) = self.window(window) else {
                        return;
                    };
                    self.focus_window(&window);
                    KeyState::Pressed
                } else {
                    KeyState::Released
                };
                self.send_key(Keycode::new(code + EVDEV_XKB_OFFSET), state);
            }
            Input::Text {
                window,
                text,
                composing,
            } => {
                let Ok(window) = self.window(window) else {
                    return;
                };
                self.focus_window(&window);
                if composing {
                    self.text_input.enter(&text, true);
                    return;
                }
                // A line break or a tab is a key to a field, not text.
                for part in text.split_inclusive(['\n', '\t']) {
                    let key = part
                        .chars()
                        .next_back()
                        .filter(|c| matches!(c, '\n' | '\t'));
                    let written = part.strip_suffix(['\n', '\t']).unwrap_or(part);
                    if !written.is_empty() && !self.text_input.enter(written, false) {
                        self.type_text(written);
                    }
                    if let Some(key) = key {
                        self.type_text(key.encode_utf8(&mut [0; 4]));
                    }
                }
                // Nothing to write ends what was being composed.
                if text.is_empty() {
                    self.text_input.enter("", false);
                }
            }
        }
    }

    /// Lets go of what is dragged with [`Input::Drop`], if it still is.
    pub fn drop_dragged(&mut self) {
        if !std::mem::take(&mut self.drop_held) {
            return;
        }
        let pointer = self.pointer();
        pointer.button(
            self,
            &ButtonEvent {
                button: button_code(Button::Left),
                state: ButtonState::Released,
                serial: SERIAL_COUNTER.next_serial(),
                time: self.time_msec(),
            },
        );
        pointer.frame(self);
    }

    pub fn focus_window(&mut self, window: &Window) {
        let Some(surface) = window.toplevel().map(|t| t.wl_surface().clone()) else {
            return;
        };
        let keyboard = self.keyboard();
        // An open popup grab owns the keyboard focus until it is dismissed.
        if keyboard.is_grabbed() || keyboard.current_focus().as_ref() == Some(&surface) {
            return;
        }
        self.space.raise_element(window, true);
        for window in self.space.elements() {
            if let Some(toplevel) = window.toplevel() {
                toplevel.send_pending_configure();
            }
        }
        keyboard.set_focus(self, Some(surface), SERIAL_COUNTER.next_serial());
    }

    fn pointer(&self) -> PointerHandle<Self> {
        self.seat.get_pointer().expect("seat has a pointer")
    }

    fn keyboard(&self) -> KeyboardHandle<Self> {
        self.seat.get_keyboard().expect("seat has a keyboard")
    }

    fn pointer_motion(&mut self, window: &Window, point: Point<f64, Logical>) {
        self.pointer_window = window_id(window);
        let location = point + frame_rect(window).loc.to_f64();
        let under = window
            .surface_under(location, WindowSurfaceType::ALL)
            .map(|(surface, origin)| (surface, origin.to_f64()));
        let pointer = self.pointer();
        pointer.motion(
            self,
            under,
            &MotionEvent {
                location,
                serial: SERIAL_COUNTER.next_serial(),
                time: self.time_msec(),
            },
        );
        pointer.frame(self);
    }

    /// Types text key by key. Characters no key of the keymap produces are left out.
    fn type_text(&mut self, text: &str) {
        let positions: Vec<KeyPosition> = text
            .chars()
            .filter_map(|c| self.key_table.find(char_keysym(c)))
            .collect();
        for position in positions {
            self.tap(position);
        }
    }

    fn tap(&mut self, key: KeyPosition) {
        self.keyboard().with_xkb_state(self, |mut context| {
            let active = context.xkb().lock().unwrap().active_layout();
            if active != key.layout {
                context.set_layout(key.layout);
            }
        });
        let shift = key
            .shift
            .then(|| self.key_table.find(Keysym::Shift_L))
            .flatten();
        if let Some(shift) = shift {
            self.send_key(shift.keycode, KeyState::Pressed);
        }
        self.send_key(key.keycode, KeyState::Pressed);
        self.send_key(key.keycode, KeyState::Released);
        if let Some(shift) = shift {
            self.send_key(shift.keycode, KeyState::Released);
        }
    }

    fn send_key(&mut self, keycode: Keycode, state: KeyState) {
        self.keyboard().input::<(), _>(
            self,
            keycode,
            state,
            SERIAL_COUNTER.next_serial(),
            self.time_msec(),
            |_, _, _| FilterResult::Forward,
        );
    }
}

fn char_keysym(c: char) -> Keysym {
    match c {
        '\n' => Keysym::Return,
        '\t' => Keysym::Tab,
        _ => xkb::utf32_to_keysym(c as u32),
    }
}
