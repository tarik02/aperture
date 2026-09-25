import * as Effect from "effect/Effect";
import {
  chromeCall,
  isMarkerTab,
  isUserTab,
  MarkerWindowError,
  markerURL,
  type IdentifiedTab,
} from "./chrome.ts";
import { loadManagedWindows, saveManagedWindows, type ManagedWindows } from "./managed-windows.ts";
import { NativeHost } from "./native-host.ts";

/**
 * Brings every normal window to the state Aperture expects: exactly one user tab per
 * managed window. Extra tabs move to windows of their own, and windows left with only
 * a marker tab close.
 */
export const reconcile = Effect.gen(function* () {
  const host = yield* NativeHost;
  const managedWindows = yield* loadManagedWindows;
  const windows = yield* chromeCall("windows.getAll", () =>
    chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
  );
  const liveWindowIds = new Set(windows.map((window) => String(window.id)));

  for (const windowId of Object.keys(managedWindows)) {
    if (!liveWindowIds.has(windowId)) delete managedWindows[windowId];
  }

  for (const window of windows) {
    const windowId = window.id;
    if (windowId === undefined) continue;
    const tabs = window.tabs ?? [];
    const userTabs = tabs.filter(isUserTab);
    if (userTabs.length === 0) {
      if (tabs.some(isMarkerTab)) yield* removeWindow(windowId);
      continue;
    }

    const managedTabId = managedWindows[String(windowId)];
    const stableManagedTab = userTabs.find((tab) => tab.id === managedTabId);
    if (!stableManagedTab) {
      for (const tab of userTabs) yield* moveTabToManagedWindow(tab, managedWindows);
      continue;
    }

    for (const tab of userTabs) {
      if (tab.id !== stableManagedTab.id) yield* moveTabToManagedWindow(tab, managedWindows);
    }
    yield* Effect.forEach(tabs.filter(isMarkerTab), (tab) => removeTab(tab.id), {
      concurrency: "unbounded",
      discard: true,
    });
    yield* host.request({ type: "window.settled", windowId, tabId: stableManagedTab.id });
  }

  yield* saveManagedWindows(managedWindows);
});

/**
 * Moves a tab into a new window that Aperture binds to its own compositor surface. The
 * window opens on a marker page, so the compositor can find its surface by the binding
 * nonce before the tab arrives. Each step undoes what came before it if a later one fails.
 */
const moveTabToManagedWindow = Effect.fnUntraced(function* (
  tab: IdentifiedTab,
  managedWindows: ManagedWindows,
) {
  const host = yield* NativeHost;
  const nonce = crypto.randomUUID();
  const cancelBinding = Effect.ignore(host.request({ type: "binding.cancel", nonce }));

  yield* host.request({ type: "binding.prepare", nonce });
  const { windowId, markerTabId } = yield* createMarkerWindow.pipe(
    Effect.onError(() => cancelBinding),
  );
  const removeMarker = removeTab(markerTabId);

  yield* host
    .request({ type: "binding.bind", nonce, windowId, tabId: tab.id })
    .pipe(
      Effect.onError(() =>
        Effect.all([removeMarker, removeWindow(windowId), cancelBinding], { discard: true }),
      ),
    );
  yield* chromeCall("tabs.move", () => chrome.tabs.move(tab.id, { windowId, index: -1 })).pipe(
    Effect.onError(() =>
      Effect.all(
        [
          removeMarker,
          Effect.ignore(host.request({ type: "window.closed", windowId })),
          removeWindow(windowId),
        ],
        { discard: true },
      ),
    ),
  );
  yield* chromeCall("tabs.update", () => chrome.tabs.update(tab.id, { active: true })).pipe(
    Effect.ensuring(removeMarker),
  );

  managedWindows[String(windowId)] = tab.id;
  yield* host.request({ type: "window.settled", windowId, tabId: tab.id });
});

const createMarkerWindow = Effect.gen(function* () {
  const window = yield* chromeCall("windows.create", () =>
    chrome.windows.create({ url: markerURL, type: "normal", focused: false }),
  );
  const markerTabId = window?.tabs?.[0]?.id;
  if (window?.id === undefined || markerTabId === undefined) {
    return yield* new MarkerWindowError();
  }
  return { windowId: window.id, markerTabId };
});

const removeTab = (tabId: number) =>
  Effect.ignore(chromeCall("tabs.remove", () => chrome.tabs.remove(tabId)));

const removeWindow = (windowId: number) =>
  Effect.ignore(chromeCall("windows.remove", () => chrome.windows.remove(windowId)));

/** Forgets a managed window that closed and tells Aperture it is gone. */
export const forgetManagedWindow = Effect.fnUntraced(function* (windowId: number) {
  const host = yield* NativeHost;
  const managedWindows = yield* loadManagedWindows;
  delete managedWindows[String(windowId)];
  yield* saveManagedWindows(managedWindows);
  yield* host
    .request({ type: "window.closed", windowId })
    .pipe(
      Effect.catchTag("NativeHostError", (error) =>
        Effect.logError("Aperture window close report failed", error),
      ),
    );
});
