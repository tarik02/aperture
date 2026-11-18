use smithay::{
    backend::input::{Axis, AxisSource, ButtonState, KeyState},
    desktop::{Window, WindowSurfaceType},
    input::{
        keyboard::{FilterResult, KeyboardHandle, Keycode, Keysym, xkb},
        pointer::{AxisFrame, ButtonEvent, MotionEvent, PointerHandle},
    },
    utils::{Logical, Point, SERIAL_COUNTER},
};

use crate::{Button, Input, keymap::KeyPosition, render::frame_rect, state::State};

/// Wheel distance of one notch, matching libinput's convention.
const SCROLL_STEP: f64 = 15.0;

/// Linux evdev codes are offset by 8 in XKB.
const EVDEV_XKB_OFFSET: u32 = 8;

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
            Input::PointerLeave => {
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
                let Ok(window) = self.window(window) else {
                    return;
                };
                self.focus_window(&window);
                let state = if pressed {
                    KeyState::Pressed
                } else {
                    KeyState::Released
                };
                self.send_key(Keycode::new(code + EVDEV_XKB_OFFSET), state);
            }
            Input::Text { window, text } => {
                let Ok(window) = self.window(window) else {
                    return;
                };
                self.focus_window(&window);
                let positions: Vec<KeyPosition> = text
                    .chars()
                    .filter_map(|c| self.key_table.find(char_keysym(c)))
                    .collect();
                for position in positions {
                    self.tap(position);
                }
            }
        }
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
