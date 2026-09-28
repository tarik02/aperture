import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Playwright } from "effect-playwright";
import { cdpForFrame, evaluate, makeCdp, type Cdp } from "./cdp.js";
import { matchesOrigin, type StorageExportInput, type StoragePartition } from "./export-schema.js";
import { canonicalOrigin, urlOrigin } from "./schema.js";

export class StorageExportError extends Schema.TaggedError<StorageExportError>()(
  "StorageExportError",
  {
    reason: Schema.Literals([
      "unsupported_partition",
      "ambiguous_http_partition",
      "unsupported_bucket",
      "partition_mismatch",
      "origin_changed",
      "export_limit",
    ]),
  },
) {
  get message(): string {
    return `Storage export failed: ${this.reason}`;
  }
}

const Sites = Schema.Array(
  Schema.Struct({
    groupingKey: Schema.String,
    origins: Schema.Array(
      Schema.Struct({ origin: Schema.String, isPartitioned: Schema.Boolean, usage: Schema.Number }),
    ),
  }),
);
const Buckets = Schema.Array(Schema.Struct({ storageKey: Schema.String, name: Schema.String }));
interface FrameTree {
  readonly frame: { readonly id: string };
  readonly childFrames?: readonly FrameTree[];
}
const FrameTree: Schema.Codec<FrameTree> = Schema.Struct({
  frame: Schema.Struct({ id: Schema.String }),
  childFrames: Schema.optionalKey(Schema.Array(Schema.suspend(() => FrameTree))),
});
const FrameTreeResult = Schema.Struct({ frameTree: FrameTree });
const TargetInfoResult = Schema.Struct({ targetInfo: Schema.Struct({ targetId: Schema.String }) });
const StorageKeyResult = Schema.Struct({ storageKey: Schema.String });

export const partitionForKey = Effect.fn("storageInventory.partitionForKey")(function* (
  storageKey: string,
  quota: boolean,
) {
  const [originText, suffix, ...extra] = storageKey.split("^");
  const origin = urlOrigin(originText);
  if (origin === null || extra.length > 0)
    return yield* new StorageExportError({ reason: "unsupported_partition" });
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
    if (top === null) return yield* new StorageExportError({ reason: "unsupported_partition" });
    ancestors = [top];
  }
  return { origin, ancestors, storageKey, quota } satisfies StoragePartition;
});

export const openStorageKeys = Effect.fn("storageInventory.openStorageKeys")(function* (
  context: Playwright.BrowserContext,
) {
  const keys = new Set<string>();
  const targets = new Set<string>();
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
      if (targets.has(targetInfo.targetId)) continue;
      targets.add(targetInfo.targetId);
      const { frameTree } = yield* cdp
        .send("Page.getFrameTree")
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(FrameTreeResult)));
      const pending = [frameTree];
      while (pending.length > 0) {
        const tree = pending.pop()!;
        const { storageKey } = yield* cdp
          .send("Storage.getStorageKeyForFrame", { frameId: tree.frame.id })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(StorageKeyResult)));
        if (urlOrigin(storageKey.split("^")[0]) !== null) keys.add(storageKey);
        pending.push(...(tree.childFrames ?? []));
      }
    }
  }
  return keys;
}, Effect.scoped);

export const discoverStorage = Effect.fn("storageInventory.discoverStorage")(function* (
  context: Playwright.BrowserContext,
  input: StorageExportInput,
  openKeys: ReadonlySet<string>,
) {
  const selected = (key: string): boolean => {
    if (input.origins === "open-tabs") return openKeys.has(key);
    const origin = urlOrigin(key.split("^")[0]);
    return origin !== null && matchesOrigin(input.origins, origin);
  };
  const inventory = new Map<string, StoragePartition>();
  const add = Effect.fn("storageInventory.add")(function* (key: string, quota: boolean) {
    if (selected(key))
      inventory.set(key, yield* partitionForKey(key, quota || inventory.get(key)?.quota === true));
  });
  // Capture pages before opening helper targets; open-tabs never includes helpers.
  for (const key of openKeys) yield* add(key, false);
  const page = yield* Effect.acquireRelease(context.newPage, (page) => Effect.ignore(page.close));
  const cdp: Cdp = makeCdp(yield* page.use((raw) => raw.context().newCDPSession(raw)));
  yield* page.goto("chrome://quota-internals", { waitUntil: "load", timeout: 15_000 });
  const buckets = yield* evaluate(
    cdp,
    `(async () => {
    const { QuotaInternalsBrowserProxy } = await import('chrome://quota-internals/quota_internals_browser_proxy.js');
    const result = await QuotaInternalsBrowserProxy.getInstance().retrieveBucketsTable();
    return result.entries.map(({storageKey, name}) => ({storageKey, name}));
  })()`,
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Buckets)));
  for (const bucket of buckets) {
    if (!selected(bucket.storageKey)) continue;
    if (bucket.name !== "_default")
      return yield* new StorageExportError({ reason: "unsupported_bucket" });
    yield* add(bucket.storageKey, true);
  }
  if (input.origins !== "open-tabs") {
    yield* page.goto("chrome://settings/content/all", { waitUntil: "load", timeout: 15_000 });
    const sites = yield* evaluate(
      cdp,
      `(async () => {
      const cr = await import('chrome://resources/js/cr.js');
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Storage inventory timed out')), 15000);
        const listener = cr.addWebUiListener('onStorageListFetched', value => {
          clearTimeout(timer); cr.removeWebUiListener(listener); resolve(value);
        });
        cr.sendWithPromise('getAllSites').catch(reject);
      });
    })()`,
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Sites)));
    for (const group of sites) {
      for (const site of group.origins) {
        const origin = urlOrigin(site.origin);
        if (site.usage === 0 || origin === null || !matchesOrigin(input.origins, origin)) continue;
        if (!site.isPartitioned) {
          yield* add(`${origin}/`, false);
          continue;
        }
        if (new URL(origin).protocol === "http:" && group.groupingKey.startsWith("etld:")) {
          // Settings merges HTTP and HTTPS top-level sites. A secure ancestor can
          // prevent probing the HTTP frame, even when old profile data exists there.
          // Refuse this ambiguity instead of silently losing a stored partition.
          return yield* new StorageExportError({ reason: "ambiguous_http_partition" });
        }
        // Settings groups partitions by site without its scheme. Quota keys above
        // are exact, but localStorage-only partitions need both scheme candidates.
        const tops = group.groupingKey.startsWith("etld:")
          ? ["http", "https"].map((scheme) => `${scheme}://${group.groupingKey.slice(5)}`)
          : [group.groupingKey.slice("origin:".length)];
        for (const top of tops) {
          const topOrigin = canonicalOrigin(top);
          if (topOrigin === null)
            return yield* new StorageExportError({ reason: "unsupported_partition" });
          const topURL = new URL(topOrigin);
          const originURL = new URL(origin);
          const sameSite =
            topURL.protocol === originURL.protocol &&
            (originURL.hostname === topURL.hostname ||
              originURL.hostname.endsWith(`.${topURL.hostname}`));
          yield* add(`${origin}/${sameSite ? "^31" : `^0${topURL.origin}`}`, false);
        }
      }
    }
    for (const pattern of input.origins) {
      const origin = pattern.includes("*") ? null : canonicalOrigin(pattern);
      if (origin !== null) yield* add(`${origin}/`, false);
    }
  }
  return [...inventory.values()];
}, Effect.scoped);
