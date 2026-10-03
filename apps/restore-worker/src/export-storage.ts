import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Playwright } from "effect-playwright";
import type { Frame } from "playwright-core";
import { cdpForFrame, evaluate, makeCdp, restoreError } from "./cdp.js";
import {
  matchesOrigin,
  OriginStorageExport,
  type ExportedStorageOrigin,
  type ExportedCookie,
  type ExportedStorageState,
  type StorageExportInput,
  type StoragePartition,
} from "./export-schema.js";
import { PayloadSource } from "./payload-source.js";
import { canonicalOrigin, Capsule, describeIssue } from "./schema.js";
import {
  discoverStorage,
  frameTree,
  isSameSite,
  openStorageKeys,
  storageKeyForFrame,
  StorageChangedError,
  UnsupportedStorageError,
} from "./storage-inventory.js";
import { frameMatchesChain, navigateIsolatedOrigin } from "./storage-origin.js";

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
const World = Schema.Struct({ executionContextId: Schema.Number });

const exportOrigin = Effect.fn("storageExport.exportOrigin")(function* (
  context: Playwright.BrowserContext,
  partition: StoragePartition,
) {
  const payloads = yield* PayloadSource;
  const page = yield* Effect.acquireRelease(context.newPage, (page) => Effect.ignore(page.close));
  const cdp = makeCdp(yield* page.use((raw) => raw.context().newCDPSession(raw)));
  yield* cdp.send("Network.enable");
  // Also covers navigations of cross-process child frames: Chromium decides them
  // through the parent frame's DevTools session, before the child target exists.
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

  // A session attached to an in-process child targets its page. The helper chain
  // has one frame per level, so the storage frame is the deepest one.
  const frameCDP = yield* cdpForFrame(frame);
  let leaf = yield* frameTree(frameCDP);
  while (leaf.childFrames !== undefined && leaf.childFrames.length > 0) {
    if (leaf.childFrames.length !== 1) {
      return yield* new StorageChangedError({ message: "storage helper frame gained children" });
    }
    leaf = leaf.childFrames[0];
  }
  const frameId = leaf.frame.id;

  if ((yield* storageKeyForFrame(frameCDP, frameId)) !== partition.storageKey) {
    return yield* new StorageChangedError({
      message: "storage helper frame has another partition",
    });
  }

  const world = yield* frameCDP
    .send("Page.createIsolatedWorld", { frameId, worldName: "aperture-storage-export" })
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(World)));
  const result = yield* evaluate(
    frameCDP,
    payloads.exportOriginStorage(partition.quota),
    world.executionContextId,
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OriginStorageExport)));
  if ("unsupported" in result) {
    return yield* new UnsupportedStorageError({
      message: `${partition.origin}: ${result.unsupported}`,
    });
  }
  const state = result.storage;
  if (state.origin !== partition.origin) {
    return yield* new StorageChangedError({ message: "storage helper frame changed origin" });
  }

  if (partition.ancestors.length === 0) {
    return state;
  }
  return { ...state, ancestorOrigins: partition.ancestors };
}, Effect.scoped);

function cookieMatchesOrigin(cookie: Cookie, origin: string): boolean {
  const url = new URL(origin);
  if (cookie.secure && url.protocol !== "https:") {
    return false;
  }
  if (!cookie.domain.startsWith(".")) {
    return url.hostname === cookie.domain;
  }
  return url.hostname === cookie.domain.slice(1) || url.hostname.endsWith(cookie.domain);
}

function cookieMatchesPartition(cookie: Cookie, partition: StoragePartition): boolean {
  if (!cookieMatchesOrigin(cookie, partition.origin)) {
    return false;
  }
  if (cookie.partitionKey === undefined) {
    return true;
  }
  const top = new URL(partition.ancestors[0] ?? partition.origin);
  return (
    isSameSite(top, new URL(cookie.partitionKey.topLevelSite)) &&
    cookie.partitionKey.hasCrossSiteAncestor === partition.ancestors.length > 0
  );
}

function isCookieSelected(
  cookie: Cookie,
  selection: StorageExportInput["origins"],
  partitions: readonly StoragePartition[],
): boolean {
  if (selection === "open-tabs") {
    return partitions.some((partition) => cookieMatchesPartition(cookie, partition));
  }
  if (selection.includes("*")) {
    return true;
  }
  if (partitions.some((partition) => cookieMatchesOrigin(cookie, partition.origin))) {
    return true;
  }

  // Cookies of sites without other storage still match patterns by their domain.
  const host = cookie.domain.replace(/^\./, "");
  const schemes = cookie.secure ? ["https"] : ["https", "http"];
  return schemes.some((scheme) => matchesOrigin(selection, `${scheme}://${host}`));
}

function toExportedCookie(cookie: Cookie): ExportedCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: !cookie.domain.startsWith("."),
    path: cookie.path,
    ...(cookie.session ? {} : { expires: cookie.expires }),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
    ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
  };
}

export const exportStorage = Effect.fn("storageExport.exportStorage")(function* (
  browser: Playwright.Browser,
  input: StorageExportInput,
) {
  const context = browser.contexts()[0];
  if (context === undefined) {
    return yield* restoreError("browser has no default context");
  }

  const openKeys = yield* openStorageKeys(context);
  const partitions = yield* discoverStorage(context, input, openKeys);

  const browserCDP = makeCdp(yield* browser.use((raw) => raw.newBrowserCDPSession()));
  const { cookies: browserCookies } = yield* browserCDP
    .send("Storage.getCookies")
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Cookies)));
  const cookies: ExportedCookie[] = [];
  for (const cookie of browserCookies) {
    if (!isCookieSelected(cookie, input.origins, partitions)) {
      continue;
    }
    if (cookie.partitionKeyOpaque === true) {
      return yield* new UnsupportedStorageError({
        message: `cookie ${JSON.stringify(cookie.name)} of ${cookie.domain} has an opaque partition key`,
      });
    }
    cookies.push(toExportedCookie(cookie));
  }

  const origins: ExportedStorageOrigin[] = [];
  for (const partition of partitions) {
    const state = yield* exportOrigin(context, partition);
    if (state.localStorage.length === 0 && !partition.quota) {
      continue;
    }
    origins.push(state);
    if (origins.length > 100) {
      return yield* new UnsupportedStorageError({
        message: "selection has more than 100 storage origins; narrow it",
      });
    }
  }

  const state: ExportedStorageState = { cookies, origins };
  // Validate the same import contract before publishing a capsule.
  yield* Schema.decodeUnknownEffect(Capsule)({ storageState: state }).pipe(
    Effect.mapError(
      (error) =>
        new UnsupportedStorageError({
          message: `exported storage exceeds storageState limits: ${describeIssue(error.issue)}`,
        }),
    ),
  );
  return state;
});
