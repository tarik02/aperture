import { Buffer } from "node:buffer";
import type { Browser, BrowserContext, CDPSession, Frame, Page, Route } from "playwright-core";
import { chromium } from "playwright-core";
import {
  capsuleSchema,
  canonicalOrigin,
  type Capsule,
  type StorageOrigin,
  type Target,
} from "./schema.js";
import { originStorageSource, sessionStorageSource, targetStateSource } from "./payload-source.js";

const minute = 60_000;
const emptyDocument = "<!doctype html><meta charset=utf-8><title>Aperture storage import</title>";
const tabWindowEnforcerOrigin = "chrome-extension://imdifnnggmlpoochobfcpghdppldpmjl/";

type CDP = CDPSession;

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  openerId?: string;
}

interface TargetResult {
  targetIds: string[];
  activeIndex: number;
  sessionStorageSources: Record<string, Record<string, string>>;
}

async function readCapsule(): Promise<Capsule> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024 * 1024) throw new InvalidCapsule();
    chunks.push(bytes);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8"), (_key, value: unknown) =>
      value === null ? undefined : value,
    );
  } catch {
    throw new InvalidCapsule();
  }

  const result = capsuleSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidCapsule();
  }
  return result.data;
}

async function cdpForPage(context: BrowserContext, page: Page): Promise<{ cdp: CDP; id: string }> {
  const cdp = await context.newCDPSession(page);
  const info = (await cdp.send("Target.getTargetInfo")) as { targetInfo: TargetInfo };
  if (!info.targetInfo?.targetId) throw new Error("browser omitted the created target ID");

  return { cdp, id: info.targetInfo.targetId };
}

async function evaluate(cdp: CDP, expression: string, contextId?: number): Promise<unknown> {
  const result = (await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(contextId === undefined ? {} : { contextId }),
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (result.exceptionDetails || !result.result || !("value" in result.result))
    throw new Error("browser could not evaluate the restore runtime");

  return result.result.value;
}

async function until<T>(operation: () => Promise<T | null>, description: string): Promise<T> {
  const deadline = Date.now() + minute;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== null) return result;
    } catch (error) {
      if (error instanceof RestoreFailure) throw error;
      // The frame can change between calls while navigation is in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`${description} within 1 minute`);
}

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

async function restoreOrigin(context: BrowserContext, origin: StorageOrigin): Promise<void> {
  const page = await context.newPage();
  const { cdp } = await cdpForPage(context, page);

  const chain = [...(origin.ancestorOrigins ?? []), origin.origin].map(
    (value) => canonicalOrigin(value)!,
  );
  const partitioned = chain.length > 1;
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
      rejectFinished?.(asError(error));
    }
  };

  try {
    await cdp.send("Page.enable");
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    if (!partitioned)
      await cdp.send("Storage.clearDataForOrigin", {
        origin: chain[0],
        storageTypes: storageTypes(origin),
      });

    await page.route("**/*", onRoute);
    await Promise.all([page.goto(chain[0], { waitUntil: "commit", timeout: minute }), finished]);

    const frame = await until(
      async () => page.frames().find((candidate) => frameOrigins(candidate, chain)) ?? null,
      "browser did not enter the storage frame",
    );

    const frameCDP = await context.newCDPSession(frame);
    const tree = (await frameCDP.send("Page.getFrameTree")) as { frameTree: FrameTree };
    const frameId = findFrameID(tree.frameTree, chain.at(-1)!);
    if (!frameId) throw new Error("browser omitted the storage frame ID");

    const contextId = await until(async () => {
      const world = (await frameCDP.send("Page.createIsolatedWorld", {
        frameId,
        worldName: "aperture-storage-import",
      })) as { executionContextId?: number };
      if (!world.executionContextId) return null;
      const actual = await evaluate(frameCDP, "location.origin", world.executionContextId);
      return actual === chain.at(-1) ? world.executionContextId : null;
    }, "browser did not enter the storage origin");

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
    if (result?.status !== "succeeded")
      throw new Error(result?.error ?? "browser returned an invalid origin storage import result");
  } finally {
    clearTimeout(timer);
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
  browserCDP: CDP,
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

async function waitForNavigation(cdp: CDP, documentState: boolean): Promise<void> {
  await until(async () => {
    const value = (await evaluate(
      cdp,
      '({ href: location.href, documentState: globalThis[Symbol.for("aperture.initial-document-state")] || null })',
    )) as { href?: string; documentState?: { status: string; error?: string } };

    if (value.documentState?.status === "failed")
      throw new RestoreFailure(`restore initial document state: ${value.documentState.error}`);
    if (
      value.href &&
      value.href !== "about:blank" &&
      (!documentState || value.documentState?.status === "succeeded")
    )
      return true;

    return null;
  }, "initial target did not navigate");
}

class RestoreFailure extends Error {}
class InvalidCapsule extends Error {}

async function createTarget(
  context: BrowserContext,
  target: Target,
  opener?: Page,
): Promise<{ page: Page; id: string; sources: Record<string, string> }> {
  const page = opener ? await createPopup(opener) : await context.newPage();
  const { cdp, id } = await cdpForPage(context, page);
  const scripts: Record<string, { identifier: string; source: string }> = {};

  try {
    await cdp.send("Page.enable");
    for (const state of target.sessionStorage ?? []) {
      const origin = canonicalOrigin(state.origin)!;
      const source = sessionStorageSource({ ...state, origin });
      const added = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source })) as {
        identifier?: string;
      };
      if (!added.identifier)
        throw new Error("browser omitted the session storage preload script identifier");
      scripts[origin] = { identifier: added.identifier, source };
    }

    const added = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: targetStateSource({
        url: target.url,
        scroll: target.scroll,
        documentState: target.documentState,
      }),
    })) as { identifier?: string };
    if (!added.identifier) throw new Error("browser omitted the target preload script identifier");

    const navigation = (await cdp.send("Page.navigate", { url: target.url })) as {
      errorText?: string;
    };
    if (navigation.errorText) throw new Error(`navigate initial target: ${navigation.errorText}`);

    await waitForNavigation(cdp, target.documentState != null);
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: added.identifier });

    const tree = (await cdp.send("Page.getFrameTree")) as { frameTree: FrameTree };
    const loaded = new Set<string>();
    collectOrigins(tree.frameTree, loaded);
    const sources: Record<string, string> = {};

    for (const [origin, script] of Object.entries(scripts)) {
      if (!loaded.has(origin)) continue;
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: script.identifier });
      delete scripts[origin];
    }

    for (const [origin, script] of Object.entries(scripts)) sources[origin] = script.source;

    return { page, id, sources };
  } catch (error) {
    await page.close().catch(() => undefined);
    throw error;
  }
}

interface FrameTree {
  frame: { id: string; url: string };
  childFrames?: FrameTree[];
}
function collectOrigins(tree: FrameTree, origins: Set<string>): void {
  try {
    const origin = canonicalOrigin(new URL(tree.frame.url).origin);
    if (origin) origins.add(origin);
  } catch {
    /* about:blank */
  }
  tree.childFrames?.forEach((child) => collectOrigins(child, origins));
}

async function createPopup(opener: Page): Promise<Page> {
  const cdp = await opener.context().newCDPSession(opener);
  try {
    const [popup, evaluation] = await Promise.all([
      opener.waitForEvent("popup", { timeout: 15_000 }),
      cdp.send("Runtime.evaluate", {
        expression:
          'globalThis[Symbol.for("aperture.initial-window-open")]("about:blank", "_blank") !== null',
        returnByValue: true,
        userGesture: true,
      }) as Promise<{ result?: { value?: boolean }; exceptionDetails?: unknown }>,
    ]);
    if (evaluation.exceptionDetails || !evaluation.result?.value)
      throw new Error("browser rejected the initial popup target");
    return popup;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

async function restore(browser: Browser, capsule: Capsule): Promise<TargetResult> {
  const context = browser.contexts()[0];
  if (!context) throw new Error("browser has no default context");

  const browserCDP = await browser.newBrowserCDPSession();
  if (capsule.storageState) {
    for (const origin of capsule.storageState.origins) await restoreOrigin(context, origin);
    await restoreCookies(browserCDP, capsule.storageState.cookies);
  }

  const targets = capsule.initialTargets ?? [];
  const result: TargetResult = {
    targetIds: [],
    activeIndex: targets.findIndex((item) => item.active),
    sessionStorageSources: {},
  };
  if (targets.length === 0) return result;

  const existing = (await browserCDP.send("Target.getTargets")) as { targetInfos: TargetInfo[] };
  const existingIDs = existing.targetInfos
    .filter(
      (item) =>
        item.type === "page" &&
        !item.url.startsWith("devtools://") &&
        !item.url.startsWith(tabWindowEnforcerOrigin),
    )
    .map((item) => item.targetId);

  const created = new Map<number, { page: Page; id: string }>();
  while (created.size < targets.length) {
    let progress = false;
    for (const [index, target] of targets.entries()) {
      if (created.has(index)) continue;
      const opener =
        target.openerTargetIndex == null ? undefined : created.get(target.openerTargetIndex)?.page;
      if (target.openerTargetIndex != null && !opener) continue;
      const made = await createTarget(context, target, opener);
      created.set(index, made);
      result.targetIds[index] = made.id;
      if (Object.keys(made.sources).length > 0)
        result.sessionStorageSources[made.id] = made.sources;
      progress = true;
    }

    if (!progress) throw new Error("initial target opener graph could not be resolved");
  }

  for (const id of existingIDs) await browserCDP.send("Target.closeTarget", { targetId: id });

  return result;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.argv[2]))
    throw new Error("usage: restore <cdp-url>");

  const capsule = await readCapsule();
  const browser = await chromium.connectOverCDP(process.argv[2], { timeout: 15_000 });

  try {
    const result = await restore(browser, capsule);
    process.stdout.write(JSON.stringify(result));
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof InvalidCapsule
      ? "invalid browser initialization\n"
      : "browser restore failed\n",
  );
  process.exitCode = 1;
});
