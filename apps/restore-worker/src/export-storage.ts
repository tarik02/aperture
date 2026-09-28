import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Playwright } from "effect-playwright";
import type { Frame } from "playwright-core";
import { cdpForFrame, evaluate, makeCdp } from "./cdp.js";
import {
  ExportedStorageOrigin,
  type ExportedStorageState,
  matchesOrigin,
  type ExportedCookie,
  type StorageExportInput,
  type StoragePartition,
} from "./export-schema.js";
import { PayloadSource } from "./payload-source.js";
import { frameMatchesChain, navigateIsolatedOrigin } from "./storage-origin.js";
import { canonicalOrigin, Capsule } from "./schema.js";
import { discoverStorage, openStorageKeys, StorageExportError } from "./storage-inventory.js";

class StorageExportValidationError extends Schema.TaggedError<StorageExportValidationError>()(
  "StorageExportValidationError",
  {
    cause: Schema.instanceOf(Schema.SchemaError),
  },
) {
  override get message(): string {
    return "Browser storage cannot be represented by storageState";
  }
}

const Cookies = Schema.Struct({
  cookies: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.String,
      domain: Schema.String,
      path: Schema.String,
      expires: Schema.Number,
      session: Schema.Boolean,
      httpOnly: Schema.Boolean,
      secure: Schema.Boolean,
      sameSite: Schema.optionalKey(Schema.Literals(["Strict", "Lax", "None"])),
      partitionKey: Schema.optionalKey(
        Schema.Struct({
          topLevelSite: Schema.String.check(
            Schema.makeFilter((value) => canonicalOrigin(value) !== null),
          ),
          hasCrossSiteAncestor: Schema.Boolean,
        }),
      ),
      partitionKeyOpaque: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
type Cookie = (typeof Cookies.Type.cookies)[number];
interface ExportFrameTree {
  readonly frame: { readonly id: string };
  readonly childFrames?: readonly ExportFrameTree[];
}
const ExportFrameTree: Schema.Codec<ExportFrameTree> = Schema.Struct({
  frame: Schema.Struct({ id: Schema.String }),
  childFrames: Schema.optionalKey(Schema.Array(Schema.suspend(() => ExportFrameTree))),
});
const FrameTreeResult = Schema.Struct({ frameTree: ExportFrameTree });
const StorageKeyResult = Schema.Struct({ storageKey: Schema.String });
const World = Schema.Struct({ executionContextId: Schema.Number });

const exportOrigin = Effect.fn("storageExport.exportOrigin")(function* (
  context: Playwright.BrowserContext,
  partition: StoragePartition,
) {
  const payloads = yield* PayloadSource;
  const page = yield* Effect.acquireRelease(context.newPage, (page) => Effect.ignore(page.close));
  const cdp = makeCdp(yield* page.use((raw) => raw.context().newCDPSession(raw)));
  yield* cdp.send("Network.enable");
  yield* cdp.send("Network.setBypassServiceWorker", { bypass: true });
  const chain = [...partition.ancestors, partition.origin];
  yield* navigateIsolatedOrigin(page, chain);
  const frame = yield* page.use(async (raw) => {
    const matches = (frame: Frame) => frameMatchesChain(frame, chain);
    return (
      raw.frames().find(matches) ??
      (await raw.waitForEvent("framenavigated", { predicate: matches, timeout: 15_000 }))
    );
  });
  yield* page.use(() => frame.waitForLoadState("domcontentloaded", { timeout: 15_000 }));
  const frameCDP = yield* cdpForFrame(frame);
  // A session attached to an in-process child targets its page. Find the leaf by
  // its actual ancestor chain, rather than assuming the session's root is the leaf.
  const tree = yield* frameCDP
    .send("Page.getFrameTree")
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(FrameTreeResult)));
  let leaf = tree.frameTree;
  while (leaf.childFrames !== undefined && leaf.childFrames.length > 0) {
    if (leaf.childFrames.length !== 1)
      return yield* new StorageExportError({ reason: "origin_changed" });
    leaf = leaf.childFrames[0];
  }
  const frameID = leaf.frame.id;
  const { storageKey } = yield* frameCDP
    .send("Storage.getStorageKeyForFrame", { frameId: frameID })
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(StorageKeyResult)));
  if (storageKey !== partition.storageKey)
    return yield* new StorageExportError({ reason: "partition_mismatch" });
  const world = yield* frameCDP
    .send("Page.createIsolatedWorld", { frameId: frameID, worldName: "aperture-storage-export" })
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(World)));
  const state = yield* evaluate(
    frameCDP,
    payloads.exportOriginStorage(partition.quota),
    world.executionContextId,
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ExportedStorageOrigin)));
  if (state.origin !== partition.origin)
    return yield* new StorageExportError({ reason: "origin_changed" });
  return {
    ...state,
    ...(partition.ancestors.length === 0 ? {} : { ancestorOrigins: partition.ancestors }),
  };
}, Effect.scoped);

function cookieMatchesOrigin(cookie: Cookie, origin: string): boolean {
  const url = new URL(origin);
  if (cookie.secure && url.protocol !== "https:") return false;
  return cookie.domain.startsWith(".")
    ? url.hostname === cookie.domain.slice(1) || url.hostname.endsWith(cookie.domain)
    : url.hostname === cookie.domain;
}

function cookieMatchesPartition(cookie: Cookie, partition: StoragePartition): boolean {
  if (!cookieMatchesOrigin(cookie, partition.origin)) return false;
  if (cookie.partitionKey === undefined) return true;
  const top = new URL(partition.ancestors[0] ?? partition.origin);
  const cookieTop = new URL(cookie.partitionKey.topLevelSite);
  return (
    top.protocol === cookieTop.protocol &&
    (top.hostname === cookieTop.hostname || top.hostname.endsWith(`.${cookieTop.hostname}`)) &&
    cookie.partitionKey.hasCrossSiteAncestor === partition.ancestors.length > 0
  );
}

export const exportStorage = Effect.fn("storageExport.exportStorage")(
  function* (browser: Playwright.Browser, input: StorageExportInput) {
    const context = browser.contexts()[0];
    if (context === undefined) return yield* new StorageExportError({ reason: "origin_changed" });
    const openKeys = yield* openStorageKeys(context);
    const partitions = yield* discoverStorage(context, input, openKeys);
    const cdp = makeCdp(yield* browser.use((raw) => raw.newBrowserCDPSession()));
    const raw = yield* cdp
      .send("Storage.getCookies")
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Cookies)));
    const cookies: ExportedCookie[] = [];
    const selection = input.origins;
    for (const cookie of raw.cookies) {
      const selected =
        selection === "open-tabs"
          ? partitions.some((partition) => cookieMatchesPartition(cookie, partition))
          : selection.includes("*") ||
            partitions.some((partition) => cookieMatchesOrigin(cookie, partition.origin)) ||
            ["https", ...(cookie.secure ? [] : ["http"])].some((scheme) =>
              matchesOrigin(selection, `${scheme}://${cookie.domain.replace(/^\./, "")}`),
            );
      if (!selected) continue;
      if (cookie.partitionKeyOpaque === true)
        return yield* new StorageExportError({ reason: "unsupported_partition" });
      cookies.push({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        hostOnly: !cookie.domain.startsWith("."),
        path: cookie.path,
        ...(!cookie.session ? { expires: cookie.expires } : {}),
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
        ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
      });
    }
    const origins: ExportedStorageOrigin[] = [];
    for (const partition of partitions) {
      const state = yield* exportOrigin(context, partition);
      if (state.localStorage.length === 0 && !partition.quota) continue;
      origins.push(state);
      if (origins.length > 100) return yield* new StorageExportError({ reason: "export_limit" });
    }
    const state: ExportedStorageState = { cookies, origins };
    // Validate the same import contract before publishing a capsule.
    yield* Schema.decodeUnknownEffect(Capsule)({ storageState: state });
    return state;
  },
  Effect.catchTag("SchemaError", (cause) =>
    Effect.fail(new StorageExportValidationError({ cause })),
  ),
);
