/** `KeyboardEvent.code` to Linux evdev key codes. */
export const KEYS: Readonly<Record<string, number>> = {
  Escape: 1,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5,
  Digit5: 6,
  Digit6: 7,
  Digit7: 8,
  Digit8: 9,
  Digit9: 10,
  Digit0: 11,
  Minus: 12,
  Equal: 13,
  Backspace: 14,
  Tab: 15,
  KeyQ: 16,
  KeyW: 17,
  KeyE: 18,
  KeyR: 19,
  KeyT: 20,
  KeyY: 21,
  KeyU: 22,
  KeyI: 23,
  KeyO: 24,
  KeyP: 25,
  BracketLeft: 26,
  BracketRight: 27,
  Enter: 28,
  ControlLeft: 29,
  KeyA: 30,
  KeyS: 31,
  KeyD: 32,
  KeyF: 33,
  KeyG: 34,
  KeyH: 35,
  KeyJ: 36,
  KeyK: 37,
  KeyL: 38,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  ShiftLeft: 42,
  Backslash: 43,
  KeyZ: 44,
  KeyX: 45,
  KeyC: 46,
  KeyV: 47,
  KeyB: 48,
  KeyN: 49,
  KeyM: 50,
  Comma: 51,
  Period: 52,
  Slash: 53,
  ShiftRight: 54,
  NumpadMultiply: 55,
  AltLeft: 56,
  Space: 57,
  CapsLock: 58,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  NumLock: 69,
  ScrollLock: 70,
  Numpad7: 71,
  Numpad8: 72,
  Numpad9: 73,
  NumpadSubtract: 74,
  Numpad4: 75,
  Numpad5: 76,
  Numpad6: 77,
  NumpadAdd: 78,
  Numpad1: 79,
  Numpad2: 80,
  Numpad3: 81,
  Numpad0: 82,
  NumpadDecimal: 83,
  IntlBackslash: 86,
  F11: 87,
  F12: 88,
  NumpadEnter: 96,
  ControlRight: 97,
  NumpadDivide: 98,
  AltRight: 100,
  Home: 102,
  ArrowUp: 103,
  PageUp: 104,
  ArrowLeft: 105,
  ArrowRight: 106,
  End: 107,
  ArrowDown: 108,
  PageDown: 109,
  Insert: 110,
  Delete: 111,
  MetaLeft: 125,
  MetaRight: 126,
  ContextMenu: 127,
};

export const KEY = {
  enter: 28,
  backspace: 14,
  delete: 111,
  a: 30,
  c: 46,
  v: 47,
} as const;

export const CONTROLS = [29, 97] as const;

export const METAS = [125, 126] as const;

/** What an event tells of the modifiers held with it. */
export interface Modifiers {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** The keys of each modifier an event tells of, on both sides. */
const MODIFIER_KEYS = [
  ["shiftKey", [42, 54]],
  ["ctrlKey", CONTROLS],
  ["altKey", [56, 100]],
  ["metaKey", METAS],
] as const;

const DIGITS = "1!2@3#4$5%6^7&8*9(0)";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

const layout = () => {
  const written: Record<string, string> = {
    Space: "  ",
    Minus: "-_",
    Equal: "=+",
    BracketLeft: "[{",
    BracketRight: "]}",
    Backslash: "\\|",
    Semicolon: ";:",
    Quote: "'\"",
    Backquote: "`~",
    Comma: ",<",
    Period: ".>",
    Slash: "/?",
  };
  for (let at = 0; at < DIGITS.length; at += 2) {
    written[`Digit${DIGITS[at]}`] = DIGITS.slice(at, at + 2);
  }
  for (const letter of LETTERS) {
    written[`Key${letter.toUpperCase()}`] = letter + letter.toUpperCase();
  }
  return written;
};

/**
 * What the keys of a US keyboard write, plain and with Shift, by `KeyboardEvent.code`.
 * The session's keyboard is a US one.
 */
export const US: Readonly<Record<string, string>> = layout();

/**
 * The keys that are down in the session, as this client pressed them. A key that was not
 * pressed here is not released there.
 */
export interface Keyboard {
  readonly press: (code: number, pressed: boolean) => void;
  readonly tap: (code: number) => void;
  /** A key with Control, as the shortcuts of the session's browser are. */
  readonly chord: (code: number) => void;
  /** Control and V, whatever modifiers are held here. */
  readonly paste: () => void;
  /**
   * Lets go of the modifiers an event says are up. Their release may never have come
   * here: the system takes some for itself, as Windows does Control and Shift that switch
   * the layout, or the AltGr's Control, and none comes to a page that is not focused.
   */
  readonly settle: (modifiers: Modifiers) => void;
  readonly releaseAll: () => void;
}

/** `send` tells whether the key went: one that did not is not held there. */
export const makeKeyboard = (send: (code: number, pressed: boolean) => boolean): Keyboard => {
  const held = new Set<number>();

  const press = (code: number, pressed: boolean) => {
    if (!pressed && !held.delete(code)) {
      return;
    }
    if (send(code, pressed) && pressed) {
      held.add(code);
    }
  };

  const tap = (code: number) => {
    press(code, true);
    press(code, false);
  };

  return {
    press,
    tap,
    chord: (code) => {
      press(CONTROLS[0], true);
      tap(code);
      press(CONTROLS[0], false);
    },
    paste: () => {
      // Command and V pastes on a Mac, and Meta held with Control and V does not there.
      for (const code of METAS) {
        press(code, false);
      }
      const controlled = CONTROLS.some((code) => held.has(code));
      if (!controlled) {
        press(CONTROLS[0], true);
      }
      tap(KEY.v);
      if (!controlled) {
        press(CONTROLS[0], false);
      }
    },
    settle: (modifiers) => {
      for (const [flag, codes] of MODIFIER_KEYS) {
        if (!modifiers[flag]) {
          for (const code of codes) {
            press(code, false);
          }
        }
      }
    },
    releaseAll: () => {
      for (const code of held) {
        press(code, false);
      }
    },
  };
};
