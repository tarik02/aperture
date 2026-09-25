import { Cause, Effect, ManagedRuntime, Queue, Stream } from "effect";
import { NativeHost } from "./native-host.ts";
import { forgetManagedWindow, reconcile } from "./reconcile.ts";

const runtime = ManagedRuntime.make(NativeHost.layer);
const reconcileRequests = Effect.runSync(Queue.unbounded<void>());
const scheduleReconcile = () => {
  Queue.offerUnsafe(reconcileRequests, undefined);
};

// Chromium only delivers the events that woke the worker to listeners registered while
// the script first runs, so these stay synchronous and top-level.
chrome.runtime.onInstalled.addListener(scheduleReconcile);
chrome.runtime.onStartup.addListener(scheduleReconcile);
chrome.tabs.onCreated.addListener(scheduleReconcile);
chrome.tabs.onUpdated.addListener(scheduleReconcile);
chrome.tabs.onAttached.addListener(scheduleReconcile);
chrome.tabs.onDetached.addListener(scheduleReconcile);
chrome.tabs.onRemoved.addListener(scheduleReconcile);
chrome.windows.onCreated.addListener(scheduleReconcile);
chrome.windows.onRemoved.addListener((windowId) => {
  runtime.runFork(forgetManagedWindow(windowId));
  scheduleReconcile();
});

// Bursts of tab events settle into one pass, and passes never overlap. A failed pass
// runs again after the next quiet period.
runtime.runFork(
  Stream.fromQueue(reconcileRequests).pipe(
    Stream.debounce("25 millis"),
    Stream.runForEach(() =>
      reconcile.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Aperture window reconciliation failed", Cause.pretty(cause)).pipe(
            Effect.andThen(Effect.sync(scheduleReconcile)),
          ),
        ),
      ),
    ),
  ),
);

scheduleReconcile();
