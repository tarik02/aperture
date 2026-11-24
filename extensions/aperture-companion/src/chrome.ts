import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

/** Serializes shared storage updates across the popup and service worker. */
export const withExtensionLock = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
  Effect.tryPromise({
    try: (signal) => navigator.locks.request(name, { signal }, () => Effect.runPromiseExit(effect)),
    catch: () => new CompanionError({ message: "Could not update the Aperture connection" }),
  }).pipe(
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
    ),
  );

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

export const hasOrigins = (origins: readonly string[]) =>
  chromeCall("permissions.contains", () => chrome.permissions.contains({ origins: [...origins] }));

/** The hosts that origin patterns name, each once, for telling a person which sites. */
export const hostsOf = (origins: readonly string[]) => [
  ...new Set(
    origins.map((pattern) => {
      try {
        return new URL(pattern.replace(/\/\*$/u, "/")).host;
      } catch {
        return pattern;
      }
    }),
  ),
];

/** What access is asked for: to teleport pages, or to connect to an Aperture. */
export type AccessFor = "teleport" | "connect";

/** What a person is told when the sites that were asked for were not given. */
export const notGiven = (origins: readonly string[], accessFor: AccessFor) =>
  accessFor === "teleport"
    ? `Access to ${hostsOf(origins).join(", ")} was not given, so nothing was teleported. Teleport again to be asked once more.`
    : `Access to ${hostsOf(origins).join(", ")} was not given, so nothing was connected. Connect again to be asked once more.`;

/** Which of the origin patterns the extension has no access to. */
export const missingOrigins = (origins: readonly string[]) =>
  Effect.forEach(origins, (origin) =>
    hasOrigins([origin]).pipe(Effect.map((granted) => (granted ? [] : [origin]))),
  ).pipe(Effect.map((missing) => missing.flat()));

/**
 * Asks the browser for access to the origin patterns, and fails unless all of it is had
 * afterwards. A prompt that is refused or dismissed answers `false`; one the browser does
 * not put up at all, as one that was not asked for from a press, rejects. Either way the
 * person is told which sites were not given, and that nothing was done: what was asked
 * for is taken whole or not at all, as pages without their sites' cookies would be put
 * back broken.
 */
export const requestOrigins = Effect.fnUntraced(function* (
  origins: readonly string[],
  accessFor: AccessFor,
) {
  const granted = yield* chromeCall("permissions.request", () =>
    chrome.permissions.request({ origins: [...origins] }),
  ).pipe(Effect.orElseSucceed(() => false));
  if (granted) return;
  // What is not known to be given is not.
  const missing = yield* missingOrigins(origins).pipe(Effect.orElseSucceed(() => origins));
  if (missing.length === 0) return;
  return yield* new CompanionError({ message: notGiven(missing, accessFor) });
});
