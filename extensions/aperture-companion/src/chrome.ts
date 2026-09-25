import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A Chromium extension API call that rejected. */
export class ChromeError extends Schema.TaggedError<ChromeError>()("ChromeError", {
  operation: Schema.String,
  cause: Schema.Unknown,
}) {}

/** A failure whose message is shown to the user as it is. */
export class CompanionError extends Schema.TaggedError<CompanionError>()("CompanionError", {
  message: Schema.String,
}) {}

export const chromeCall = <A>(operation: string, call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (cause) => new ChromeError({ operation, cause }) });

/** A tab the extension can address. */
export interface IdentifiedTab extends chrome.tabs.Tab {
  readonly id: number;
}

/** Only HTTP and HTTPS pages can be captured and restored. */
export function isWebURL(value: string | undefined): value is string {
  if (value === undefined) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export const getTab = (tabId: number) => chromeCall("tabs.get", () => chrome.tabs.get(tabId));

export const openTab = (url: string) =>
  chromeCall("tabs.create", () => chrome.tabs.create({ url })).pipe(Effect.asVoid);

/** Asks for access to the given origin patterns; fails with `message` when it is refused. */
export const requestOrigins = Effect.fnUntraced(function* (
  origins: readonly string[],
  message: string,
) {
  const granted = yield* chromeCall("permissions.request", () =>
    chrome.permissions.request({ origins: [...origins] }),
  );
  if (!granted) return yield* new CompanionError({ message });
});

export const hasOrigins = (origins: readonly string[]) =>
  chromeCall("permissions.contains", () => chrome.permissions.contains({ origins: [...origins] }));
