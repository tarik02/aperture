import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Playwright } from "effect-playwright";
import { cdpForFrame, evaluate, makeCdp, type Cdp } from "./cdp.js";
import { matchesOrigin, type StorageExportInput, type StoragePartition } from "./export-schema.js";
import { canonicalOrigin, urlOrigin } from "./schema.js";

/** Storage changed while the export was reading it. */
export class StorageChangedError extends Data.TaggedError("StorageChangedError")<{
  readonly message: string;
}> {}

/**
 * Selected storage that storageState cannot represent. Go returns the message to
 * the API caller, so it must not contain stored values.
 */
export class UnsupportedStorageError extends Data.TaggedError("UnsupportedStorageError")<{
  readonly message: string;
}> {
  readonly [Runtime.errorExitCode] = 3;
}

const unsupportedPartition = () =>
  new UnsupportedStorageError({
    message: "selected storage uses a partition that storageState cannot represent",
  });

interface FrameTree {
  readonly frame: { readonly id: string };
  readonly childFrames?: readonly FrameTree[];
}
const FrameTree: Schema.Codec<FrameTree> = Schema.Struct({
  frame: Schema.Struct({ id: Schema.String }),
  childFrames: Schema.optionalKey(Schema.Array(Schema.suspend(() => FrameTree))),
});
const FrameTreeResult = Schema.Struct({ frameTree: FrameTree });
const StorageKeyResult = Schema.Struct({ storageKey: Schema.String });
const TargetInfoResult = Schema.Struct({ targetInfo: Schema.Struct({ targetId: Schema.String }) });
const Buckets = Schema.Array(Schema.Struct({ storageKey: Schema.String, name: Schema.String }));
const Sites = Schema.Array(
  Schema.Struct({
    groupingKey: Schema.String,
    origins: Schema.Array(
      Schema.Struct({ origin: Schema.String, isPartitioned: Schema.Boolean, usage: Schema.Number }),
    ),
  }),
);

export const frameTree = (cdp: Cdp) =>
  cdp.send("Page.getFrameTree").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(FrameTreeResult)),
    Effect.map((result) => result.frameTree),
  );

export const storageKeyForFrame = (cdp: Cdp, frameId: string) =>
  cdp.send("Storage.getStorageKeyForFrame", { frameId }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(StorageKeyResult)),
    Effect.map((result) => result.storageKey),
  );

/** Chromium serializes a storage key as `<origin>/` with optional `^`-separated partition data. */
function storageKeyOrigin(storageKey: string): string | null {
  return urlOrigin(storageKey.split("^")[0]);
}

/** Whether `url` belongs to `site`, which is a scheme and registrable domain. */
export function isSameSite(url: URL, site: URL): boolean {
  return (
    url.protocol === site.protocol &&
    (url.hostname === site.hostname || url.hostname.endsWith(`.${site.hostname}`))
  );
}

export const partitionForKey = Effect.fn("storageInventory.partitionForKey")(function* (
  storageKey: string,
  quota: boolean,
) {
  const [originText, suffix, ...extra] = storageKey.split("^");
  const origin = urlOrigin(originText);
  if (origin === null || extra.length > 0) return yield* unsupportedPartition();

  let ancestors: readonly string[] = [];
  if (suffix === "31") {
    // Storage keys retain a cross-site bit, not the original ancestor URLs. An
    // equivalent chain recreates that partition when the capsule is imported.
    const bridge =
      new URL(origin).hostname === "aperture-storage.invalid"
        ? "https://aperture-partition.invalid"
        : "https://aperture-storage.invalid";
    ancestors = [origin, bridge];
  } else if (suffix !== undefined) {
    const top = suffix.startsWith("0") ? canonicalOrigin(suffix.slice(1)) : null;
    if (top === null) return yield* unsupportedPartition();
    ancestors = [top];
  }
  return { origin, ancestors, storageKey, quota } satisfies StoragePartition;
});

export const openStorageKeys = Effect.fn("storageInventory.openStorageKeys")(function* (
  context: Playwright.BrowserContext,
) {
  const keys = new Set<string>();
  const visitedTargets = new Set<string>();
  for (const page of context.pages()) {
    const frames = yield* page.use((raw) => Promise.resolve(raw.frames()));
    for (const frame of frames) {
      // Page.getFrameTree omits out-of-process child frames. Attach to every
      // Playwright frame so their local trees and storage keys are included too.
      const cdp = yield* cdpForFrame(frame);
      yield* Effect.addFinalizer(() => Effect.ignore(cdp.detach));
      const { targetInfo } = yield* cdp
        .send("Target.getTargetInfo")
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(TargetInfoResult)));
      if (visitedTargets.has(targetInfo.targetId)) continue;
      visitedTargets.add(targetInfo.targetId);

      const pending = [yield* frameTree(cdp)];
      while (pending.length > 0) {
        const tree = pending.pop()!;
        const storageKey = yield* storageKeyForFrame(cdp, tree.frame.id);
        if (storageKeyOrigin(storageKey) !== null) keys.add(storageKey);
        pending.push(...(tree.childFrames ?? []));
      }
    }
  }
  return keys;
}, Effect.scoped);

/** Every quota-managed storage bucket in the profile, including those of closed sites. */
const quotaBuckets = Effect.fnUntraced(function* (page: Playwright.Page, cdp: Cdp) {
  yield* page.goto("chrome://quota-internals", { waitUntil: "load", timeout: 15_000 });
  return yield* evaluate(
    cdp,
    `(async () => {
      const { QuotaInternalsBrowserProxy } = await import('chrome://quota-internals/quota_internals_browser_proxy.js');
      const result = await QuotaInternalsBrowserProxy.getInstance().retrieveBucketsTable();
      return result.entries.map(({ storageKey, name }) => ({ storageKey, name }));
    })()`,
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Buckets)));
});

/** Site-data groups from Chromium settings, which also cover localStorage-only origins. */
const siteData = Effect.fnUntraced(function* (page: Playwright.Page, cdp: Cdp) {
  yield* page.goto("chrome://settings/content/all", { waitUntil: "load", timeout: 15_000 });
  return yield* evaluate(
    cdp,
    `(async () => {
      const cr = await import('chrome://resources/js/cr.js');
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Storage inventory timed out')), 15000);
        const listener = cr.addWebUiListener('onStorageListFetched', (value) => {
          clearTimeout(timer);
          cr.removeWebUiListener(listener);
          resolve(value);
        });
        cr.sendWithPromise('getAllSites').catch(reject);
      });
    })()`,
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Sites)));
});

/** Candidate storage keys of a partitioned origin listed under a settings site group. */
const partitionedSiteKeys = Effect.fnUntraced(function* (origin: string, groupingKey: string) {
  const originURL = new URL(origin);
  const isSchemelessSite = groupingKey.startsWith("etld:");
  if (originURL.protocol === "http:" && isSchemelessSite) {
    // Settings merges HTTP and HTTPS top-level sites. A secure ancestor can
    // prevent probing the HTTP frame, even when old profile data exists there.
    // Refuse this ambiguity instead of silently losing a stored partition.
    return yield* new UnsupportedStorageError({
      message:
        "partitioned storage of an HTTP origin has an unknown top-level scheme; export it with open-tabs while its page is open",
    });
  }

  // Settings groups partitions by site without its scheme. Quota keys are exact,
  // but localStorage-only partitions need both scheme candidates.
  const tops = isSchemelessSite
    ? ["http", "https"].map((scheme) => `${scheme}://${groupingKey.slice("etld:".length)}`)
    : [groupingKey.slice("origin:".length)];

  const keys: string[] = [];
  for (const top of tops) {
    const topOrigin = canonicalOrigin(top);
    if (topOrigin === null) return yield* unsupportedPartition();
    const topURL = new URL(topOrigin);
    keys.push(`${origin}/${isSameSite(originURL, topURL) ? "^31" : `^0${topURL.origin}`}`);
  }
  return keys;
});

export const discoverStorage = Effect.fn("storageInventory.discoverStorage")(function* (
  context: Playwright.BrowserContext,
  input: StorageExportInput,
  openKeys: ReadonlySet<string>,
) {
  const { origins: selection } = input;
  const isSelected = (key: string): boolean => {
    if (selection === "open-tabs") return openKeys.has(key);
    const origin = storageKeyOrigin(key);
    return origin !== null && matchesOrigin(selection, origin);
  };

  const inventory = new Map<string, StoragePartition>();
  const add = Effect.fnUntraced(function* (key: string, quota: boolean) {
    if (!isSelected(key)) return;
    const hasQuota = quota || inventory.get(key)?.quota === true;
    inventory.set(key, yield* partitionForKey(key, hasQuota));
  });

  // Capture pages before opening helper targets; open-tabs never includes helpers.
  for (const key of openKeys) yield* add(key, false);

  const page = yield* Effect.acquireRelease(context.newPage, (page) => Effect.ignore(page.close));
  const cdp = makeCdp(yield* page.use((raw) => raw.context().newCDPSession(raw)));

  for (const bucket of yield* quotaBuckets(page, cdp)) {
    if (!isSelected(bucket.storageKey)) continue;
    if (bucket.name !== "_default")
      return yield* new UnsupportedStorageError({
        message: "named storage buckets are not supported",
      });
    yield* add(bucket.storageKey, true);
  }

  if (selection === "open-tabs") return [...inventory.values()];

  for (const group of yield* siteData(page, cdp)) {
    for (const site of group.origins) {
      const origin = urlOrigin(site.origin);
      if (site.usage === 0 || origin === null || !matchesOrigin(selection, origin)) continue;
      const keys = site.isPartitioned
        ? yield* partitionedSiteKeys(origin, group.groupingKey)
        : [`${origin}/`];
      for (const key of keys) yield* add(key, false);
    }
  }

  // Exact origins are always probed, even when no inventory reports them.
  for (const pattern of selection) {
    const origin = pattern.includes("*") ? null : canonicalOrigin(pattern);
    if (origin !== null) yield* add(`${origin}/`, false);
  }
  return [...inventory.values()];
}, Effect.scoped);
