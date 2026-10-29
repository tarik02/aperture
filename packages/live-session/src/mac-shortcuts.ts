/** Whether this client runs on macOS, where Cmd and Option carry the editing shortcuts. */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** One key press or release a translated shortcut is made of, with the modifiers held after it. */
export interface ShortcutKey {
  readonly code: string;
  readonly key: string;
  readonly action: "down" | "up";
  readonly modifiers: number;
}

const ALT = 1;
const CONTROL = 2;
const SHIFT = 8;

const MODIFIER_BITS: Record<string, number> = {
  AltLeft: ALT,
  AltRight: ALT,
  ControlLeft: CONTROL,
  ShiftLeft: SHIFT,
};

const KEY_NAMES: Record<string, string> = {
  AltLeft: "Alt",
  AltRight: "Alt",
  ControlLeft: "Control",
  ShiftLeft: "Shift",
  Home: "Home",
  End: "End",
};

/** Keys that keep their meaning as Ctrl shortcuts: Cmd+Z becomes Ctrl+Z. */
function isControlShortcutCode(code: string) {
  return (
    /^(Key[A-Z]|Digit[0-9])$/.test(code) ||
    ["BracketLeft", "BracketRight", "Minus", "Equal", "Slash", "Enter"].includes(code)
  );
}

class KeySequence {
  readonly keys: ShortcutKey[] = [];

  constructor(private modifiers: number) {}

  press(code: string, key = KEY_NAMES[code] ?? code) {
    this.modifiers |= MODIFIER_BITS[code] ?? 0;
    this.keys.push({ code, key, action: "down", modifiers: this.modifiers });
  }

  release(code: string, key = KEY_NAMES[code] ?? code) {
    this.modifiers &= ~(MODIFIER_BITS[code] ?? 0);
    this.keys.push({ code, key, action: "up", modifiers: this.modifiers });
  }

  tap(code: string, key?: string) {
    this.press(code, key);
    this.release(code, key);
  }

  holding(code: string, keys: () => void) {
    this.press(code);
    keys();
    this.release(code);
  }
}

/**
 * The keys a Linux browser needs for a macOS editing shortcut, or null when the event is not one.
 * Cmd is never forwarded on macOS, so Cmd shortcuts become Ctrl ones and Cmd's line and document
 * moves become Home and End. Option word moves become Ctrl ones; heldAlt is the Alt key the
 * browser holds, released around them because Alt+Left would go back in history there.
 */
export function translateMacShortcut(
  event: KeyboardEvent,
  heldAlt: string | null,
): ShortcutKey[] | null {
  const held = (event.shiftKey ? SHIFT : 0) | (heldAlt ? ALT : 0);
  const sequence = new KeySequence(held);
  const { code } = event;

  if (event.metaKey && !event.ctrlKey) {
    switch (code) {
      case "ArrowLeft":
        sequence.tap("Home");
        break;
      case "ArrowRight":
        sequence.tap("End");
        break;
      case "ArrowUp":
        sequence.holding("ControlLeft", () => sequence.tap("Home"));
        break;
      case "ArrowDown":
        sequence.holding("ControlLeft", () => sequence.tap("End"));
        break;
      case "Backspace":
      case "Delete": {
        const edge = code === "Backspace" ? "Home" : "End";
        if (event.shiftKey) {
          sequence.tap(edge);
        } else {
          sequence.holding("ShiftLeft", () => sequence.tap(edge));
        }
        sequence.tap(code);
        break;
      }
      default:
        if (!isControlShortcutCode(code)) {
          return null;
        }
        sequence.holding("ControlLeft", () => sequence.tap(code, event.key));
    }
    return sequence.keys;
  }

  const wordMove =
    code === "ArrowLeft" || code === "ArrowRight" || code === "Backspace" || code === "Delete";
  if (event.altKey && !event.ctrlKey && wordMove) {
    const control = () => sequence.holding("ControlLeft", () => sequence.tap(code));
    if (heldAlt) {
      sequence.release(heldAlt);
      control();
      sequence.press(heldAlt);
    } else {
      control();
    }
    return sequence.keys;
  }

  return null;
}
