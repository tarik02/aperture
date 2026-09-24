import { decodeStructuredClone } from "@aperture/browser-state";
import { errorMessage } from "./error.js";
import { preloadErrorKey, windowOpenKey } from "./page-keys.js";

export interface TargetPreload {
  url: string;
  windowName?: string;
  historyState?: string;
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
    if (state.historyState !== undefined) {
      history.replaceState(decodeStructuredClone(state.historyState), "");
    }
  } catch (error) {
    Reflect.set(window, Symbol.for(preloadErrorKey), errorMessage(error));
  }
}
