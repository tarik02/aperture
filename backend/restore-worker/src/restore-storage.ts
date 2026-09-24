import type { BrowserContext, CDPSession, Frame, Page, Route } from "playwright-core";
import { cdpForPage, evaluate, type FrameTree } from "./cdp.js";
import { originStorageSource } from "./payload-source.js";
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

async function navigateIsolatedOrigin(page: Page, chain: readonly string[]): Promise<void> {
  let served = 0;
  const finished = Promise.withResolvers<void>();
  const timer = setTimeout(
    () =>
      finished.reject(
        new Error("browser did not request the isolated origin document within 1 minute"),
      ),
    minute,
  );

  // Serve a synthetic document for each origin in the chain, each embedding the next one.
  const onRoute = async (route: Route): Promise<void> => {
    if (route.request().resourceType() !== "document") {
      await route.abort();
      return;
    }

    if (served >= chain.length || urlOrigin(route.request().url()) !== chain[served]) {
      finished.reject(new Error("browser requested an unexpected partition origin"));
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
      if (served === chain.length) finished.resolve();
    } catch (error) {
      finished.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  try {
    await page.route("**/*", onRoute);
    await Promise.all([
      page.goto(chain[0], { waitUntil: "commit", timeout: minute }),
      finished.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function restoreOrigin(context: BrowserContext, origin: StorageOrigin): Promise<void> {
  const page = await context.newPage();
  const chain = [...(origin.ancestorOrigins ?? []), origin.origin].map(
    (value) => canonicalOrigin(value)!,
  );
  const destinationOrigin = chain[chain.length - 1];
  const partitioned = chain.length > 1;
  const types = storageTypes(origin);

  try {
    const { cdp } = await cdpForPage(context, page);
    await cdp.send("Page.enable");
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    if (!partitioned) {
      await cdp.send("Storage.clearDataForOrigin", {
        origin: destinationOrigin,
        storageTypes: types,
      });
    }

    await navigateIsolatedOrigin(page, chain);

    const frame =
      page.frames().find((candidate) => frameMatchesChain(candidate, chain)) ??
      (await page.waitForEvent("framenavigated", {
        predicate: (candidate) => frameMatchesChain(candidate, chain),
        timeout: minute,
      }));
    await frame.waitForLoadState("domcontentloaded", { timeout: minute });

    const frameCDP = await context.newCDPSession(frame);
    const tree = (await frameCDP.send("Page.getFrameTree")) as { frameTree: FrameTree };
    const frameId = findFrameID(tree.frameTree, destinationOrigin);
    if (!frameId) throw new Error("browser omitted the storage frame ID");

    const world = (await frameCDP.send("Page.createIsolatedWorld", {
      frameId,
      worldName: "aperture-storage-import",
    })) as { executionContextId?: number };
    if (!world.executionContextId) throw new Error("browser omitted the storage execution context");

    const contextId = world.executionContextId;
    const actualOrigin = await evaluate(frameCDP, "location.origin", contextId);
    if (actualOrigin !== destinationOrigin) {
      throw new Error("browser entered an unexpected storage origin");
    }

    if (partitioned) {
      const key = (await frameCDP.send("Storage.getStorageKeyForFrame", { frameId })) as {
        storageKey?: string;
      };
      if (!key.storageKey) throw new Error("browser omitted the destination storage partition key");
      await frameCDP.send("Storage.clearDataForStorageKey", {
        storageKey: key.storageKey,
        storageTypes: types,
      });
    }

    const result = (await evaluate(frameCDP, originStorageSource(origin), contextId)) as {
      status?: string;
      error?: string;
    } | null;
    if (result?.status !== "succeeded") {
      throw new Error(result?.error ?? "browser returned an invalid origin storage import result");
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

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

async function restoreCookies(
  browserCDP: CDPSession,
  cookies: NonNullable<Capsule["storageState"]>["cookies"],
): Promise<void> {
  if (cookies.length === 0) return;

  await browserCDP.send("Storage.setCookies", {
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
  });
}

export async function restoreStorage(
  context: BrowserContext,
  browserCDP: CDPSession,
  storage: NonNullable<Capsule["storageState"]>,
): Promise<void> {
  for (const origin of storage.origins) {
    await restoreOrigin(context, origin);
  }

  await restoreCookies(browserCDP, storage.cookies);
}
