import * as Effect from "effect/Effect";
import type { Playwright } from "effect-playwright";
import type { Frame } from "playwright-core";
import {
  attempt,
  cdpForPage,
  cdpForFrame,
  evaluate,
  restoreError,
  type Cdp,
  type FrameTree,
} from "./cdp.js";
import { PayloadSource } from "./payload-source.js";
import { canonicalOrigin, urlOrigin, type Capsule, type StorageOrigin } from "./schema.js";
import { frameMatchesChain, navigateIsolatedOrigin } from "./storage-origin.js";

const minute = 60_000;

// Storage replaced for an imported origin. Cookies are not cleared: they are imported
// separately and additively, so an origin import keeps an existing login.
function storageTypes(origin: StorageOrigin): string {
  const types = ["local_storage"];
  if (origin.indexedDB !== undefined) {
    types.push("indexeddb");
  }
  if (origin.cacheStorage !== undefined) {
    types.push("cache_storage");
  }
  if (origin.opfs !== undefined) {
    types.push("file_systems");
  }

  return types.join(",");
}

const restoreOrigin = Effect.fnUntraced(function* (
  context: Playwright.BrowserContext,
  origin: StorageOrigin,
) {
  const payloads = yield* PayloadSource;
  const page = yield* Effect.acquireRelease(context.newPage, (page) => Effect.ignore(page.close));
  const chain = [...(origin.ancestorOrigins ?? []), origin.origin].map(
    (value) => canonicalOrigin(value)!,
  );
  const destinationOrigin = chain[chain.length - 1];
  const partitioned = chain.length > 1;
  const types = storageTypes(origin);

  const { cdp } = yield* cdpForPage(page);
  yield* cdp.send("Page.enable");
  yield* cdp.send("Network.enable");
  yield* cdp.send("Network.setBypassServiceWorker", { bypass: true });
  if (!partitioned) {
    yield* cdp.send("Storage.clearDataForOrigin", {
      origin: destinationOrigin,
      storageTypes: types,
    });
  }

  yield* navigateIsolatedOrigin(page, chain);

  const frame = yield* page.use(async (raw) => {
    const matches = (candidate: Frame) => frameMatchesChain(candidate, chain);
    return (
      raw.frames().find(matches) ??
      (await raw.waitForEvent("framenavigated", { predicate: matches, timeout: minute }))
    );
  });
  yield* attempt(() => frame.waitForLoadState("domcontentloaded", { timeout: minute }));

  const frameCDP = yield* cdpForFrame(frame);
  const tree = yield* frameCDP.send<{ frameTree: FrameTree }>("Page.getFrameTree");
  const frameId = findFrameID(tree.frameTree, destinationOrigin);
  if (!frameId) {
    return yield* restoreError("browser omitted the storage frame ID");
  }

  const world = yield* frameCDP.send<{ executionContextId?: number }>("Page.createIsolatedWorld", {
    frameId,
    worldName: "aperture-storage-import",
  });
  if (!world.executionContextId) {
    return yield* restoreError("browser omitted the storage execution context");
  }

  const contextId = world.executionContextId;
  const actualOrigin = yield* evaluate(frameCDP, "location.origin", contextId);
  if (actualOrigin !== destinationOrigin) {
    return yield* restoreError("browser entered an unexpected storage origin");
  }

  if (partitioned) {
    const key = yield* frameCDP.send<{ storageKey?: string }>("Storage.getStorageKeyForFrame", {
      frameId,
    });
    if (!key.storageKey) {
      return yield* restoreError("browser omitted the destination storage partition key");
    }
    yield* frameCDP.send("Storage.clearDataForStorageKey", {
      storageKey: key.storageKey,
      storageTypes: types,
    });
  }

  const result = (yield* evaluate(frameCDP, payloads.originStorage(origin), contextId)) as {
    status?: string;
    error?: string;
  } | null;
  if (result?.status !== "succeeded") {
    return yield* restoreError(
      result?.error ?? "browser returned an invalid origin storage import result",
    );
  }
}, Effect.scoped);

function findFrameID(tree: FrameTree, origin: string): string | null {
  for (const child of tree.childFrames ?? []) {
    const found = findFrameID(child, origin);
    if (found) {
      return found;
    }
  }

  return urlOrigin(tree.frame.url) === origin ? tree.frame.id : null;
}

function restoreCookies(
  browserCDP: Cdp,
  cookies: NonNullable<Capsule["storageState"]>["cookies"],
): Effect.Effect<void, Playwright.PlaywrightError> {
  if (cookies.length === 0) {
    return Effect.void;
  }

  return Effect.asVoid(
    browserCDP.send("Storage.setCookies", {
      cookies: cookies.map((cookie) => {
        const { domain, hostOnly, partitionKey, expires, sameSite, ...rest } = cookie;
        return {
          ...rest,
          ...(hostOnly ? { url: `${cookie.secure ? "https" : "http"}://${domain}/` } : { domain }),
          ...(expires == null ? {} : { expires }),
          ...(sameSite === undefined ? {} : { sameSite }),
          ...(partitionKey == null
            ? {}
            : {
                partitionKey: {
                  topLevelSite: partitionKey.topLevelSite,
                  hasCrossSiteAncestor: partitionKey.hasCrossSiteAncestor ?? false,
                },
              }),
        };
      }),
    }),
  );
}

export const restoreStorage = Effect.fnUntraced(function* (
  context: Playwright.BrowserContext,
  browserCDP: Cdp,
  storage: NonNullable<Capsule["storageState"]>,
) {
  for (const origin of storage.origins) {
    yield* restoreOrigin(context, origin);
  }

  yield* restoreCookies(browserCDP, storage.cookies);
});
