import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A Chromium extension API call that rejected. */
export class ChromeError extends Schema.TaggedError<ChromeError>()("ChromeError", {
  operation: Schema.String,
  cause: Schema.Unknown,
}) {}

/** Chromium created a window without the ID or the marker tab the extension asked for. */
export class MarkerWindowError extends Schema.TaggedError<MarkerWindowError>()(
  "MarkerWindowError",
  {},
) {
  override readonly message = "Chromium did not create the Aperture marker window";
}

export const chromeCall = <A>(operation: string, call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (cause) => new ChromeError({ operation, cause }) });

export interface IdentifiedTab extends chrome.tabs.Tab {
  readonly id: number;
}

export const markerURL = chrome.runtime.getURL("marker.html");

const tabURL = (tab: chrome.tabs.Tab) => tab.url ?? tab.pendingUrl ?? "";

/** A page the user or a session opened, as opposed to a marker tab. */
export const isUserTab = (tab: chrome.tabs.Tab): tab is IdentifiedTab =>
  Boolean(tab.id && tabURL(tab) && !tabURL(tab).startsWith(markerURL));

/** The placeholder tab a managed window is created with. */
export const isMarkerTab = (tab: chrome.tabs.Tab): tab is IdentifiedTab =>
  Boolean(tab.id && tabURL(tab).startsWith(markerURL));
