import { decodeStructuredClone } from "@aperture/browser-state";
import type { Target } from "../schema.js";
import { createDocumentReplay } from "./document-state.js";

export function run(state: Target): void {
  if (window.top !== window) return;

  Reflect.set(window, Symbol.for("aperture.initial-window-open"), window.open.bind(window));
  const marker = Symbol.for("aperture.initial-document-state");
  const documentState = state.documentState;
  if (documentState) Reflect.set(window, marker, { status: "pending" });

  const fail = (error: unknown): void => {
    Reflect.set(window, marker, {
      status: "failed",
      error: error instanceof Error ? error.name + ": " + error.message : String(error),
    });
  };

  try {
    const restoreTarget = location.href === new URL(state.url).href;
    const restoreDocument = Boolean(documentState && restoreTarget);
    const documentReplay = createDocumentReplay(state);

    if (restoreDocument && documentState?.windowName !== undefined) {
      window.name = String(documentState.windowName);
    }

    let historyRestored = false;
    const restoreHistory = (): void => {
      if (!historyRestored && restoreDocument && documentState?.historyState !== undefined) {
        history.replaceState(decodeStructuredClone(String(documentState.historyState)), "");
        historyRestored = true;
      }
    };

    let interrupted = false;
    let hydrated = false;
    let observer: MutationObserver | undefined;
    const interruptEvents = ["beforeinput", "keydown", "pointerdown"];

    const stop = (): void => {
      interrupted = true;
      observer?.disconnect();
      for (const eventName of interruptEvents) {
        removeEventListener(eventName, interrupt, true);
      }
    };

    const interrupt = (event: Event): void => {
      if (event.isTrusted) stop();
    };

    for (const eventName of interruptEvents) {
      addEventListener(eventName, interrupt, { capture: true });
    }

    const replay = (dispatchEvents: boolean): void => {
      if (interrupted || !restoreTarget) return;
      documentReplay.replay(dispatchEvents);
    };

    const start = (): void => {
      if (restoreTarget) {
        restoreHistory();
        replay(false);
      }

      if (restoreDocument) {
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
      }
    };

    const finalReplay = (): void => {
      hydrated = true;
      replay(true);

      if (!interrupted && restoreDocument) {
        documentReplay.restoreFocusAndSelection();
        documentReplay.restoreScroll();
      }
    };

    const complete = (): void => {
      try {
        finalReplay();
        if (documentState) Reflect.set(window, marker, { status: "succeeded" });
      } catch (error) {
        fail(error);
      }

      const retry = (): void => {
        try {
          finalReplay();
        } catch {
          // The document can change again after the initial replay.
        }
      };

      requestAnimationFrame(() => requestAnimationFrame(retry));
      setTimeout(retry, 100);
      setTimeout(retry, 500);
    };

    const ready = (): void => {
      try {
        start();
        complete();
      } catch (error) {
        fail(error);
      }
    };

    if (document.readyState === "loading") {
      addEventListener("DOMContentLoaded", ready, { once: true });
    } else {
      ready();
    }
  } catch (error) {
    if (documentState) fail(error);
  }
}
