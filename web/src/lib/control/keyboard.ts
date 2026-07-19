import type { ClientMessage } from "#/lib/control/messages.ts";

type KeyboardInputMessage = Extract<ClientMessage, { type: "input.key" }>;

const CODE_TO_WINDOWS_VIRTUAL_KEY: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  NumpadEnter: 13,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  MetaLeft: 91,
  MetaRight: 92,
  ContextMenu: 93,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
};

const KEY_TO_WINDOWS_VIRTUAL_KEY: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
};

const FORWARDED_BROWSER_SHORTCUT_CODES = new Set([
  "KeyA",
  "KeyC",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyR",
  "KeyS",
  "KeyT",
  "KeyW",
  "KeyX",
  "KeyV",
  "KeyZ",
  "KeyY",
  "BracketLeft",
  "BracketRight",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Backspace",
  "Delete",
  "Enter",
  "Tab",
]);

export function keyboardModifiers(event: KeyboardEvent | MouseEvent | WheelEvent): number {
  let modifiers = 0;
  if (event.altKey) {
    modifiers |= 1;
  }
  if (event.ctrlKey) {
    modifiers |= 2;
  }
  if (event.metaKey) {
    modifiers |= 4;
  }
  if (event.shiftKey) {
    modifiers |= 8;
  }
  return modifiers;
}

export function isPrintableKey(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function keyboardInputMessage(
  event: KeyboardEvent,
  action: KeyboardInputMessage["action"],
): Omit<KeyboardInputMessage, "type" | "targetId" | "action"> {
  const virtualKeyCode = windowsVirtualKeyCodeForCodeOrKey(event.code, event.key);
  const modifiers = keyboardModifiers(event);
  const text = action === "down" && isPrintableKey(event) ? event.key : undefined;
  const unmodifiedText = event.key.length === 1 ? event.key : undefined;

  return {
    key: event.key,
    code: event.code,
    text,
    unmodifiedText,
    modifiers,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    location: event.location,
    autoRepeat: event.repeat,
    isKeypad: event.location === KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
  };
}

export function shouldForwardBrowserShortcut(event: KeyboardEvent): boolean {
  if (event.key === "Escape") {
    return false;
  }

  if (isModifierCode(event.code)) {
    return true;
  }

  const mod = event.metaKey || event.ctrlKey;
  if (!mod) {
    return true;
  }

  return FORWARDED_BROWSER_SHORTCUT_CODES.has(event.code);
}

export function windowsVirtualKeyCodeForCodeOrKey(
  code: string | undefined,
  key: string | undefined,
): number {
  const byCode = code ? CODE_TO_WINDOWS_VIRTUAL_KEY[code] : undefined;
  if (byCode !== undefined) {
    return byCode;
  }

  if (code?.startsWith("Key") && code.length === 4) {
    return code.charCodeAt(3);
  }

  if (code?.startsWith("Digit") && code.length === 6) {
    return code.charCodeAt(5);
  }

  if (code?.startsWith("Numpad") && code.length === 7) {
    const digit = Number(code.slice(6));
    if (Number.isInteger(digit) && digit >= 0 && digit <= 9) {
      return 96 + digit;
    }
  }

  if (code?.startsWith("F")) {
    const functionKey = Number(code.slice(1));
    if (Number.isInteger(functionKey) && functionKey >= 1 && functionKey <= 24) {
      return 111 + functionKey;
    }
  }

  const byKey = key ? KEY_TO_WINDOWS_VIRTUAL_KEY[key] : undefined;
  if (byKey !== undefined) {
    return byKey;
  }

  if (key?.length === 1) {
    return key.toUpperCase().charCodeAt(0);
  }

  return 0;
}

function isModifierCode(code: string): boolean {
  return (
    code === "AltLeft" ||
    code === "AltRight" ||
    code === "ControlLeft" ||
    code === "ControlRight" ||
    code === "MetaLeft" ||
    code === "MetaRight" ||
    code === "ShiftLeft" ||
    code === "ShiftRight"
  );
}
