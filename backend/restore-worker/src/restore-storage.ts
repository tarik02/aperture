import { Deferred, Effect } from "effect";
import { Playwright } from "effect-playwright";
import type { Frame, Route } from "playwright-core";
import {
  attempt,
  cdpForPage,
  evaluate,
  makeCdp,
  restoreError,
  type Cdp,
  type FrameTree,
  type RestoreError,
} from "./cdp.js";
import { PayloadSource } from "./payload-source.js";
import { canonicalOrigin, urlOrigin, type Capsule, type StorageOrigin } from "./schema.js";

const minute = 60_000;
const emptyDocument = "<!doctype html><meta charset=utf-8><title>Aperture storage import</title>";

// Storage replaced for an imported origin. Cookies are not cleared: they are imported
// separately and additively, so an origin import keeps an existing login.
function storageTypes(origin: StorageOrigin): string {
  const types = ["local_storage"];
  if (origin.indexedDB !== undefined) types.push("indexeddb");
  if (origin.cacheStorage !== undefined) types.push("cache_storage");
  if (origin.opfs !== undefined) types.push("file_systems");

  return types.join(",");
}

function documentForChild(origin: string): string {
  const escaped = origin.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<!doctype html><meta charset=utf-8><title>Aperture storage partition import</title><iframe src="${escaped}"></iframe>`;
}

const navigateIsolatedOrigin = Effect.fnUntraced(function* (
  page: Playwright.Page,
  chain: readonly string[],
) {
  let served = 0;
  const finished = yield* Deferred.make<void, RestoreError | Playwright.PlaywrightError>();
  const fail = (error: RestoreError | Playwright.PlaywrightError) =>
    Deferred.doneUnsafe(finished, Effect.fail(error));

  // Serve a synthetic document for each origin in the chain, each embedding the next one.
  const onRoute = async (route: Route): Promise<void> => {
    if (route.request().resourceType() !== "document") {
      await route.abort();
      return;
    }

    if (served >= chain.length || urlOrigin(route.request().url()) !== chain[served]) {
      fail(restoreError("browser requested an unexpected partition origin"));
      await route.abort();
      return;
    }

    const child = chain[served + 1];
    served++;
    try {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: { "Cache-Control": "no-store" },
        body: child === undefined ? emptyDocument : documentForChild(child),
      });
      if (served === chain.length) Deferred.doneUnsafe(finished, Effect.void);
    } catch (cause) {
      fail(new Playwright.PlaywrightError({ reason: "Unknown", cause }));
    }
  };

  yield* page.use((raw) => raw.route("**/*", onRoute));
  yield* Effect.all(
    [
      page.goto(chain[0], { waitUntil: "commit", timeout: minute }),
      Deferred.await(finished).pipe(
        Effect.timeoutOrElse({
          duration: minute,
          orElse: () =>
            Effect.fail(
              restoreError("browser did not request the isolated origin document within 1 minute"),
            ),
        }),
      ),
    ],
    { concurrency: "unbounded", discard: true },
  );
});

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

  const frameCDP = makeCdp(yield* page.use((raw) => raw.context().newCDPSession(frame)));
  const tree = yield* frameCDP.send<{ frameTree: FrameTree }>("Page.getFrameTree");
  const frameId = findFrameID(tree.frameTree, destinationOrigin);
  if (!frameId) return yield* restoreError("browser omitted the storage frame ID");

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

function frameMatchesChain(frame: Frame, chain: readonly string[]): boolean {
  const origins: (string | null)[] = [];
  for (let current: Frame | null = frame; current; current = current.parentFrame()) {
    origins.unshift(urlOrigin(current.url()));
  }

  return origins.length === chain.length && origins.every((value, index) => value === chain[index]);
}

function findFrameID(tree: FrameTree, origin: string): string | null {
  for (const child of tree.childFrames ?? []) {
    const found = findFrameID(child, origin);
    if (found) return found;
  }

  return urlOrigin(tree.frame.url) === origin ? tree.frame.id : null;
}

function restoreCookies(
  browserCDP: Cdp,
  cookies: NonNullable<Capsule["storageState"]>["cookies"],
): Effect.Effect<void, Playwright.PlaywrightError> {
  if (cookies.length === 0) return Effect.void;

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
