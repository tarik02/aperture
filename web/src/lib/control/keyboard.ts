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

export function shouldForwardBrowserShortcut(event: KeyboardEvent): boolean {
  if (event.key === "Escape") {
    return false;
  }

  const mod = event.metaKey || event.ctrlKey;
  if (!mod) {
    return true;
  }

  const key = event.key.toLowerCase();
  const forwarded = new Set([
    "a",
    "c",
    "f",
    "g",
    "h",
    "j",
    "k",
    "l",
    "n",
    "o",
    "p",
    "r",
    "s",
    "t",
    "w",
    "x",
    "v",
    "z",
    "y",
    "[",
    "]",
    "arrowleft",
    "arrowright",
    "arrowup",
    "arrowdown",
    "backspace",
    "delete",
    "enter",
    "tab",
  ]);

  return forwarded.has(key);
}
