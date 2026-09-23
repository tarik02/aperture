import type { BrowserContext, CDPSession, Frame, Page, Route } from "playwright-core";
import { cdpForPage, evaluate, type FrameTree } from "./cdp.js";
import { originStorageSource } from "./payload-source.js";
import { canonicalOrigin, type Capsule, type StorageOrigin } from "./schema.js";

const minute = 60_000;
const emptyDocument = "<!doctype html><meta charset=utf-8><title>Aperture storage import</title>";

function storageTypes(origin: StorageOrigin): string {
  const types = ["cookies", "local_storage"];
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
  let expected = 0;
  let resolveFinished: (() => void) | undefined;
  let rejectFinished: ((error: Error) => void) | undefined;

  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const timer = setTimeout(
    () =>
      rejectFinished?.(
        new Error("browser did not request the isolated origin document within 1 minute"),
      ),
    minute,
  );

  const onRoute = async (route: Route): Promise<void> => {
    if (route.request().resourceType() !== "document") {
      await route.abort();
      return;
    }

    let requestedOrigin: string | null = null;
    try {
      requestedOrigin = canonicalOrigin(new URL(route.request().url()).origin);
    } catch {
      /* Invalid navigation URL. */
    }

    if (expected >= chain.length || requestedOrigin !== chain[expected]) {
      rejectFinished?.(new Error("browser requested an unexpected partition origin"));
      await route.abort();
      return;
    }

    const body =
      expected + 1 < chain.length ? documentForChild(chain[expected + 1]) : emptyDocument;
    expected++;
    try {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: { "Cache-Control": "no-store" },
        body,
      });
      if (expected === chain.length) resolveFinished?.();
    } catch (error) {
      rejectFinished?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  try {
    await page.route("**/*", onRoute);
    await Promise.all([page.goto(chain[0], { waitUntil: "commit", timeout: minute }), finished]);
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

  try {
    const { cdp } = await cdpForPage(context, page);
    await cdp.send("Page.enable");
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    if (!partitioned) {
      await cdp.send("Storage.clearDataForOrigin", {
        origin: chain[0],
        storageTypes: storageTypes(origin),
      });
    }

    await navigateIsolatedOrigin(page, chain);

    const frame =
      page.frames().find((candidate) => frameOrigins(candidate, chain)) ??
      (await page.waitForEvent("framenavigated", {
        predicate: (candidate) => frameOrigins(candidate, chain),
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
        storageTypes: storageTypes(origin),
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

function frameOrigins(frame: Frame, expected: readonly string[]): boolean {
  const origins: string[] = [];
  for (let current: Frame | null = frame; current; current = current.parentFrame()) {
    try {
      const origin = canonicalOrigin(new URL(current.url()).origin);
      if (!origin) return false;
      origins.unshift(origin);
    } catch {
      return false;
    }
  }

  return (
    origins.length === expected.length && origins.every((value, index) => value === expected[index])
  );
}

function findFrameID(tree: FrameTree, origin: string): string | null {
  for (const child of tree.childFrames ?? []) {
    const found = findFrameID(child, origin);
    if (found) return found;
  }

  try {
    if (canonicalOrigin(new URL(tree.frame.url).origin) === origin) return tree.frame.id;
  } catch {
    /* about:blank */
  }
  return null;
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
