import { decodeStructuredClone } from "@aperture/browser-state";
import type { Target } from "../schema.js";
import { createDocumentReplay } from "./document-state.js";
import { errorMessage } from "./error.js";
import { documentStatusKey, windowOpenKey } from "./page-keys.js";

const interruptEvents = ["beforeinput", "keydown", "pointerdown"];
const replayDuration = 5000;

function onDOMContentLoaded(callback: () => void): void {
  if (document.readyState === "loading") {
    addEventListener("DOMContentLoaded", callback, { once: true });
  } else {
    callback();
  }
}

export function run(state: Target): void {
  if (window.top !== window) return;

  // The worker opens popup targets through the unpatched window.open.
  Reflect.set(window, Symbol.for(windowOpenKey), window.open.bind(window));

  // The worker polls this marker only when the target carries document state.
  const { documentState } = state;
  const setStatus = (status: "pending" | "succeeded" | "failed", error?: unknown): void => {
    if (!documentState) return;
    Reflect.set(
      window,
      Symbol.for(documentStatusKey),
      status === "failed" ? { status, error: errorMessage(error) } : { status },
    );
  };
  setStatus("pending");

  try {
    // The navigation ended up on a different URL, so the saved document state does not apply.
    if (location.href !== new URL(state.url).href) {
      onDOMContentLoaded(() => setStatus("succeeded"));
      return;
    }

    const documentReplay = createDocumentReplay(state);
    if (documentState?.windowName !== undefined) window.name = documentState.windowName;

    // Replay runs for a few seconds after load and stops early once the user interacts.
    let stopped = false;
    let hydrated = false;
    let observer: MutationObserver | undefined;
    const stop = (): void => {
      stopped = true;
      observer?.disconnect();
      for (const eventName of interruptEvents) removeEventListener(eventName, interrupt, true);
    };
    const interrupt = (event: Event): void => {
      if (event.isTrusted) stop();
    };
    for (const eventName of interruptEvents) {
      addEventListener(eventName, interrupt, { capture: true });
    }

    const replay = (dispatchEvents: boolean): void => {
      if (!stopped) documentReplay.replay(dispatchEvents);
    };

    const finalReplay = (): void => {
      hydrated = true;
      if (stopped) return;

      documentReplay.replay(true);
      if (documentState) {
        documentReplay.restoreFocusAndSelection();
        documentReplay.restoreScroll();
      }
    };

    // Frameworks may re-render the page while hydrating, so keep replaying on DOM changes.
    // Events are dispatched only once the page scripts can handle them.
    const observeHydration = (): void => {
      let scheduled = false;
      observer = new MutationObserver(() => {
        if (scheduled || stopped) return;

        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          replay(hydrated);
        });
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    };

    const retry = (): void => {
      try {
        finalReplay();
      } catch {
        // The document can change again after the initial replay.
      }
    };

    onDOMContentLoaded(() => {
      setTimeout(stop, replayDuration);
      try {
        if (documentState?.historyState !== undefined) {
          history.replaceState(decodeStructuredClone(documentState.historyState), "");
        }
        replay(false);
        if (documentState) observeHydration();

        finalReplay();
        setStatus("succeeded");
      } catch (error) {
        setStatus("failed", error);
        return;
      }

      requestAnimationFrame(() => requestAnimationFrame(retry));
      setTimeout(retry, 100);
      setTimeout(retry, 500);
    });
  } catch (error) {
    setStatus("failed", error);
  }
}
