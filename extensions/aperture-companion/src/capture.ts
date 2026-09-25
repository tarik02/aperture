import type * as Api from "@aperture-browser/api-schema";
import * as Effect from "effect/Effect";
import { capturePageState, type CapturedPageState } from "./capture-page.ts";
import {
  chromeCall,
  CompanionError,
  getTab,
  isWebURL,
  requestOrigins,
  type IdentifiedTab,
} from "./chrome.ts";
import { captureDocumentState, type CapturedDocumentState } from "./document-state.ts";
import { codecKey } from "./page-keys.ts";

/** Everything a new session needs to continue where the selected tabs are. */
export interface CapturedBrowserState {
  readonly targets: Api.InitialBrowserTarget[];
  readonly storageState: Api.InitialBrowserStorageState;
  readonly warnings: string[];
}

interface CapturedTab {
  readonly tab: IdentifiedTab;
  readonly top: CapturedPageState;
  readonly frames: CapturedPageState[];
  readonly document: CapturedDocumentState;
}

type StorageOrigin = {
  -readonly [K in keyof Api.InitialStorageOrigin]: Api.InitialStorageOrigin[K];
};

// Sessions accept larger payloads, but restoring beyond this gets slow.
const preferredPayloadBytes = 48 * 1024 * 1024;

// Optional storage in the order it is dropped when the payload is too large.
const optionalStorage = [
  ["cacheStorage", "Cache Storage"],
  ["opfs", "OPFS"],
  ["indexedDB", "IndexedDB"],
] as const;

const tabOriginPattern = (tab: chrome.tabs.Tab) => {
  if (tab.url === undefined) {
    return Effect.fail(new CompanionError({ message: "A selected tab is unavailable" }));
  }
  if (!isWebURL(tab.url)) {
    return Effect.fail(
      new CompanionError({ message: "Teleport supports HTTP and HTTPS pages only" }),
    );
  }
  return Effect.succeed(`${new URL(tab.url).origin}/*`);
};

/** The origin patterns capturing the tabs needs access to. */
export const capturePermissionOrigins = Effect.fnUntraced(function* (
  tabs: readonly chrome.tabs.Tab[],
) {
  if (tabs.length === 0) return yield* new CompanionError({ message: "No web pages are selected" });
  return [...new Set(yield* Effect.forEach(tabs, tabOriginPattern))];
});

export const requestCapturePermissions = (tabs: readonly chrome.tabs.Tab[]) =>
  capturePermissionOrigins(tabs).pipe(
    Effect.flatMap((origins) =>
      requestOrigins(origins, "Access to the selected websites was not granted"),
    ),
  );

/** Captures the selected tabs; `activeTabId` is the one the session shows first. */
export const captureBrowserState = Effect.fn("captureBrowserState")(function* (
  tabs: readonly chrome.tabs.Tab[],
  activeTabId: number,
) {
  if (tabs.length === 0) {
    return yield* new CompanionError({ message: "No browser tabs were selected" });
  }
  const pages = yield* Effect.forEach(tabs, captureTab, { concurrency: "unbounded" });
  yield* captureProfileStorage(pages);
  yield* Effect.forEach(pages, ensureNotNavigated, { concurrency: "unbounded", discard: true });

  const selectedHosts = new Set(
    pages.flatMap(({ frames }) => frames.map(({ href }) => new URL(href).hostname.toLowerCase())),
  );
  const selectedTopLevelSites = pages.map(({ top }) => new URL(top.href));
  const cookies = (yield* chromeCall("cookies.getAll", () => chrome.cookies.getAll({})))
    .filter((cookie) => cookieMatchesSelectedContext(cookie, selectedHosts, selectedTopLevelSites))
    .map(toInitialCookie);
  const origins = yield* mergeOrigins(pages);

  const targetIndexByTabId = new Map(pages.map(({ tab }, index) => [tab.id, index]));
  const targets = yield* Effect.forEach(pages, ({ tab, top, frames, document }) =>
    mergeSessionStorage(frames).pipe(
      Effect.map((sessionStorage): Api.InitialBrowserTarget => {
        const openerTargetIndex =
          document.hasOpener && tab.openerTabId !== undefined
            ? targetIndexByTabId.get(tab.openerTabId)
            : undefined;
        return {
          url: top.href,
          sessionStorage,
          scroll: top.scroll,
          documentState: document.state,
          ...(openerTargetIndex === undefined ? {} : { openerTargetIndex }),
          active: tab.id === activeTabId,
        };
      }),
    ),
  );

  const warnings = pages.flatMap(({ frames, document }) => [
    ...frames.flatMap((frame) => frame.warnings),
    ...document.warnings,
  ]);
  const storageState = { cookies, origins };
  yield* trimOptionalStorage(storageState, targets, warnings);
  return { targets, storageState, warnings } satisfies CapturedBrowserState;
});

const injectCodec = (target: chrome.scripting.InjectionTarget) =>
  chromeCall("scripting.executeScript", () =>
    chrome.scripting.executeScript({ target, files: ["capture-codec.js"] }),
  );

/** Web Storage of every web frame in the tab, or of one frame with its profile storage too. */
const capturePageStates = Effect.fnUntraced(function* (
  tabId: number,
  includeProfileStorage: boolean,
  frameId?: number,
) {
  const target =
    frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
  yield* injectCodec(target);
  const injections = yield* chromeCall("scripting.executeScript", () =>
    chrome.scripting.executeScript({
      target,
      func: capturePageState,
      args: [codecKey, includeProfileStorage],
    }),
  );
  const captured = injections.flatMap(({ frameId: resultFrameId, result }) =>
    result !== undefined && isWebURL(result.href) ? [{ ...result, frameId: resultFrameId }] : [],
  );
  if (!captured.some((frame) => frame.frameId === (frameId ?? 0))) {
    return yield* new CompanionError({
      message: "The requested frame did not return browser state",
    });
  }
  return captured;
});

const captureTopDocument = Effect.fnUntraced(function* (tabId: number) {
  const target = { tabId, frameIds: [0] };
  yield* injectCodec(target);
  const [injection] = yield* chromeCall("scripting.executeScript", () =>
    chrome.scripting.executeScript({ target, func: captureDocumentState, args: [codecKey] }),
  );
  if (injection?.result === undefined) {
    return yield* new CompanionError({ message: "The page did not return document state" });
  }
  return injection.result;
});

const captureTab = Effect.fnUntraced(function* (tab: chrome.tabs.Tab) {
  if (tab.id === undefined || tab.url === undefined) {
    return yield* new CompanionError({ message: "A selected tab is unavailable" });
  }
  if (!isWebURL(tab.url)) {
    return yield* new CompanionError({ message: "Teleport supports HTTP and HTTPS pages only" });
  }
  const tabId = tab.id;
  const expectedOrigin = new URL(tab.url).origin;

  const [frames, document] = yield* Effect.all(
    [capturePageStates(tabId, false), captureTopDocument(tabId)],
    { concurrency: "unbounded" },
  );
  const top = frames.find(({ frameId }) => frameId === 0);
  if (top === undefined) {
    return yield* new CompanionError({
      message: "The selected tab did not return its main frame state",
    });
  }
  for (const frame of frames) {
    if (frame.frameId === 0 && frame.ancestorOrigins.length !== 0) {
      return yield* new CompanionError({
        message: "The selected tab returned an invalid main frame partition",
      });
    }
    if (frame.frameId !== 0 && frame.ancestorOrigins[0] !== top.origin) {
      return yield* new CompanionError({
        message: `A frame returned an invalid storage partition for ${frame.origin}`,
      });
    }
  }

  const current = yield* getTab(tabId);
  if (
    current.url !== top.href ||
    document.href !== top.href ||
    top.origin !== new URL(top.href).origin ||
    top.origin !== expectedOrigin
  ) {
    return yield* new CompanionError({
      message: `The tab navigated while its state was being captured: ${tab.title ?? tab.url}`,
    });
  }
  return { tab: { ...current, id: tabId }, top, frames, document } satisfies CapturedTab;
});

/**
 * IndexedDB, Cache Storage and OPFS are shared by every frame in a storage partition, so
 * each partition is read once, from the first of its frames that can still read it.
 */
const captureProfileStorage = Effect.fnUntraced(function* (tabs: readonly CapturedTab[]) {
  const partitions = new Map<string, Array<{ tabId: number; frame: CapturedPageState }>>();
  for (const { tab, frames } of tabs) {
    for (const frame of frames) {
      if (!frame.webStorageCaptured) continue;
      const partition = storagePartitionKey(frame);
      const candidates = partitions.get(partition) ?? [];
      candidates.push({ tabId: tab.id, frame });
      partitions.set(partition, candidates);
    }
  }

  yield* Effect.forEach(
    partitions,
    Effect.fnUntraced(function* ([partition, candidates]) {
      for (const { tabId, frame } of candidates) {
        const [profile] = yield* capturePageStates(tabId, true, frame.frameId);
        if (
          profile === undefined ||
          profile.origin !== frame.origin ||
          storagePartitionKey(profile) !== partition
        ) {
          return yield* new CompanionError({
            message: `A frame navigated while ${frame.origin} was being captured`,
          });
        }
        frame.warnings.push(...profile.warnings);
        if (!profile.webStorageCaptured) continue;
        frame.indexedDB = profile.indexedDB;
        frame.cacheStorage = profile.cacheStorage;
        frame.opfs = profile.opfs;
        frame.profileStorageCaptured = true;
        return;
      }
    }),
    { concurrency: "unbounded", discard: true },
  );
});

const ensureNotNavigated = Effect.fnUntraced(function* ({ tab, top }: CapturedTab) {
  const current = yield* getTab(tab.id);
  if (current.url !== top.href) {
    return yield* new CompanionError({
      message: `The tab navigated while its state was being captured: ${tab.title ?? top.href}`,
    });
  }
});

/** One entry per storage partition; frames sharing one must have seen the same local storage. */
const mergeOrigins = Effect.fnUntraced(function* (pages: readonly CapturedTab[]) {
  const origins = new Map<string, StorageOrigin>();
  for (const page of pages.flatMap(({ frames }) => frames)) {
    if (!page.webStorageCaptured) continue;
    const partition = storagePartitionKey(page);
    const existing = origins.get(partition);
    if (existing !== undefined) {
      if (JSON.stringify(existing.localStorage) !== JSON.stringify(page.localStorage)) {
        return yield* new CompanionError({
          message: `Local storage changed while ${page.origin} was being captured`,
        });
      }
      if (page.profileStorageCaptured) {
        if (page.indexedDB !== undefined) existing.indexedDB = page.indexedDB;
        if (page.cacheStorage !== undefined) existing.cacheStorage = page.cacheStorage;
        if (page.opfs !== undefined) existing.opfs = page.opfs;
      }
      continue;
    }
    origins.set(partition, {
      origin: page.origin,
      ...(page.ancestorOrigins.length === 0 ? {} : { ancestorOrigins: page.ancestorOrigins }),
      localStorage: page.localStorage,
      ...(page.profileStorageCaptured
        ? {
            ...(page.indexedDB === undefined ? {} : { indexedDB: page.indexedDB }),
            ...(page.cacheStorage === undefined ? {} : { cacheStorage: page.cacheStorage }),
            ...(page.opfs === undefined ? {} : { opfs: page.opfs }),
          }
        : {}),
    });
  }
  return [...origins.values()];
});

/** A tab's session storage per origin; its frames of one origin must agree on it. */
const mergeSessionStorage = Effect.fnUntraced(function* (frames: readonly CapturedPageState[]) {
  const origins = new Map<string, Api.InitialTargetStorageOrigin>();
  for (const frame of frames) {
    if (!frame.webStorageCaptured) continue;
    const existing = origins.get(frame.origin);
    if (existing === undefined) {
      origins.set(frame.origin, { origin: frame.origin, entries: frame.sessionStorage });
    } else if (JSON.stringify(existing.entries) !== JSON.stringify(frame.sessionStorage)) {
      return yield* new CompanionError({
        message: `Session storage changed while ${frame.origin} was being captured`,
      });
    }
  }
  return [...origins.values()];
});

/**
 * Drops optional storage, starting with the kind least likely to matter and with the last
 * origins, until the payload fits. Fails when the essential state alone does not.
 */
function trimOptionalStorage(
  storageState: { readonly origins: StorageOrigin[] },
  targets: readonly Api.InitialBrowserTarget[],
  warnings: string[],
): Effect.Effect<void, CompanionError> {
  const fits = () =>
    new TextEncoder().encode(JSON.stringify({ storageState, targets })).byteLength <=
    preferredPayloadBytes;

  for (const [key, label] of optionalStorage) {
    if (fits()) return Effect.void;
    let omitted = false;
    for (const origin of [...storageState.origins].reverse()) {
      if (fits()) break;
      if (origin[key] !== undefined) {
        delete origin[key];
        omitted = true;
      }
    }
    if (omitted) {
      warnings.push(`${label} was omitted because the captured browser state is too large`);
    }
  }
  return fits()
    ? Effect.void
    : Effect.fail(
        new CompanionError({
          message: "The selected tabs contain more than 48 MiB of essential browser state",
        }),
      );
}

function storagePartitionKey(page: CapturedPageState): string {
  return [page.origin, ...page.ancestorOrigins].join("\u0000");
}

/** Cookies a selected frame could send, including partitioned ones of a selected site. */
function cookieMatchesSelectedContext(
  cookie: chrome.cookies.Cookie,
  selectedHosts: Set<string>,
  selectedTopLevelSites: URL[],
): boolean {
  const cookieDomain = cookie.domain.replace(/^\./, "").toLowerCase();
  const domainMatches = [...selectedHosts].some(
    (hostname) => hostname === cookieDomain || hostname.endsWith(`.${cookieDomain}`),
  );
  if (!domainMatches) return false;

  if (cookie.partitionKey === undefined) return true;
  if (cookie.partitionKey.topLevelSite === undefined) return false;

  const partitionSite = new URL(cookie.partitionKey.topLevelSite);
  return selectedTopLevelSites.some(
    (selectedSite) =>
      selectedSite.protocol === partitionSite.protocol &&
      (selectedSite.hostname === partitionSite.hostname ||
        selectedSite.hostname.endsWith(`.${partitionSite.hostname}`)),
  );
}

function toInitialCookie(cookie: chrome.cookies.Cookie): Api.InitialBrowserCookie {
  const cookieSameSite = sameSite(cookie.sameSite);
  const topLevelSite = cookie.partitionKey?.topLevelSite;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    ...(cookie.hostOnly ? { hostOnly: true } : {}),
    ...(cookie.expirationDate === undefined ? {} : { expires: cookie.expirationDate }),
    ...(cookie.httpOnly ? { httpOnly: true } : {}),
    ...(cookie.secure ? { secure: true } : {}),
    ...(cookieSameSite === undefined ? {} : { sameSite: cookieSameSite }),
    ...(topLevelSite === undefined
      ? {}
      : {
          partitionKey: {
            topLevelSite,
            ...(cookie.partitionKey?.hasCrossSiteAncestor === undefined
              ? {}
              : { hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor }),
          },
        }),
  };
}

function sameSite(value: chrome.cookies.Cookie["sameSite"]): Api.BrowserCookieSameSite | undefined {
  switch (value) {
    case "strict":
      return "Strict";
    case "lax":
      return "Lax";
    case "no_restriction":
      return "None";
    case "unspecified":
      return undefined;
  }
}
