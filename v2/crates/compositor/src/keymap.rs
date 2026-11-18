use std::collections::HashMap;

use smithay::input::keyboard::{Keycode, Keysym, Layout, Xkb};

/// Where a keysym lives on the keyboard: which key, in which layout, with or without Shift.
#[derive(Debug, Clone, Copy)]
pub struct KeyPosition {
    pub keycode: Keycode,
    pub layout: Layout,
    pub shift: bool,
}

/// Reverse lookup keysym → key, used to type text through a real keymap instead of sending
/// characters that the keymap cannot produce.
#[derive(Debug, Default)]
pub struct KeyTable {
    by_keysym: HashMap<u32, KeyPosition>,
}

impl KeyTable {
    pub fn build(xkb: &Xkb) -> Self {
        // Safety: the keymap reference does not outlive `xkb`.
        let keymap = unsafe { xkb.keymap() };
        let mut by_keysym = HashMap::new();

        // Earlier layouts and lower levels win, so `a` maps to the unshifted key of layout 0.
        for layout in 0..keymap.num_layouts() {
            for level in 0..2 {
                for raw in keymap.min_keycode().raw()..=keymap.max_keycode().raw() {
                    let keycode = Keycode::new(raw);
                    if level >= keymap.num_levels_for_key(keycode, layout) {
                        continue;
                    }
                    for keysym in keymap.key_get_syms_by_level(keycode, layout, level) {
                        by_keysym.entry(keysym.raw()).or_insert(KeyPosition {
                            keycode,
                            layout: Layout(layout),
                            shift: level == 1,
                        });
                    }
                }
            }
        }

        Self { by_keysym }
    }

    pub fn find(&self, keysym: Keysym) -> Option<KeyPosition> {
        self.by_keysym.get(&keysym.raw()).copied()
    }
}
