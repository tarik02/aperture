import { decodeStructuredClone } from "@aperture/browser-state";
import { errorMessage } from "./error.js";
import { preloadErrorKey, windowOpenKey } from "./page-keys.js";

export interface TargetPreload {
  url: string;
  windowName?: string;
}

// Runs before page scripts: state that pages read while starting up has to be in place
// by then. Everything else is restored by the worker once the page has loaded.
export function run(state: TargetPreload): void {
  if (window.top !== window) return;

  // The worker opens popup targets through the unpatched window.open.
  Reflect.set(window, Symbol.for(windowOpenKey), window.open.bind(window));

  // The saved state belongs to this exact URL, not to wherever a redirect led.
  if (location.href !== new URL(state.url).href) return;

  try {
    if (state.windowName !== undefined) window.name = state.windowName;
  } catch (error) {
    Reflect.set(window, Symbol.for(preloadErrorKey), errorMessage(error));
  }
}

// A same-document navigation from a pending-commit RenderFrameHost is invalid Chromium
// IPC. The worker calls this only after the cross-document navigation has committed.
export function restoreHistoryState(encoded: string): string | undefined {
  try {
    history.replaceState(decodeStructuredClone(encoded), "");
  } catch (error) {
    return errorMessage(error);
  }
}
