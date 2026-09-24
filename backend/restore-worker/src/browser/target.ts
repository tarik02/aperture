import { decodeStructuredClone } from "@aperture/browser-state";
import type { Target } from "../schema.js";
import { createDocumentReplay } from "./document-state.js";
import { errorMessage } from "./error.js";

const statusMarker = Symbol.for("aperture.initial-document-state");
const interruptEvents = ["beforeinput", "keydown", "pointerdown"];

function onDOMContentLoaded(callback: () => void): void {
  if (document.readyState === "loading") {
    addEventListener("DOMContentLoaded", callback, { once: true });
  } else {
    callback();
  }
}

export function run(state: Target): void {
  if (window.top !== window) return;

  Reflect.set(window, Symbol.for("aperture.initial-window-open"), window.open.bind(window));

  // The worker polls this marker only when the target carries document state.
  const { documentState } = state;
  const setStatus = (status: "pending" | "succeeded" | "failed", error?: unknown): void => {
    if (!documentState) return;
    Reflect.set(
      window,
      statusMarker,
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

    // Stop replaying as soon as the user starts interacting with the page.
    let interrupted = false;
    let hydrated = false;
    let observer: MutationObserver | undefined;
    const interrupt = (event: Event): void => {
      if (!event.isTrusted) return;
      interrupted = true;
      observer?.disconnect();
      for (const eventName of interruptEvents) removeEventListener(eventName, interrupt, true);
    };
    for (const eventName of interruptEvents) {
      addEventListener(eventName, interrupt, { capture: true });
    }

    const replay = (dispatchEvents: boolean): void => {
      if (!interrupted) documentReplay.replay(dispatchEvents);
    };

    const finalReplay = (): void => {
      hydrated = true;
      if (interrupted) return;

      documentReplay.replay(true);
      if (documentState) {
        documentReplay.restoreFocusAndSelection();
        documentReplay.restoreScroll();
      }
    };

    // Frameworks may re-render the page while hydrating, so keep replaying on DOM changes
    // for a few seconds. Events are dispatched only once the page scripts can handle them.
    const observeHydration = (): void => {
      let scheduled = false;
      observer = new MutationObserver(() => {
        if (scheduled || interrupted) return;

        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          replay(hydrated);
        });
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => observer?.disconnect(), 5000);
    };

    const retry = (): void => {
      try {
        finalReplay();
      } catch {
        // The document can change again after the initial replay.
      }
    };

    onDOMContentLoaded(() => {
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
