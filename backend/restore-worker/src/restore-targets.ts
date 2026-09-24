import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { cdpForPage, type FrameTree, type TargetInfo } from "./cdp.js";
import { preloadErrorKey, windowOpenKey } from "./browser/page-keys.js";
import {
  sessionStorageSource,
  targetHistoryStateSource,
  targetPreloadSource,
} from "./payload-source.js";
import { restoreDocument } from "./restore-document.js";
import { canonicalOrigin, urlOrigin, type Target } from "./schema.js";

const tabWindowEnforcerOrigin = "chrome-extension://imdifnnggmlpoochobfcpghdppldpmjl/";
const minute = 60_000;

export interface TargetResult {
  targetIds: string[];
  activeIndex: number;
  sessionStorageSources: Record<string, Record<string, string>>;
}

interface CreatedTarget {
  page: Page;
  id: string;
  sources: Record<string, string>;
}

// Fails the target when the preload could not apply history state or window.name.
async function checkPreload(page: Page): Promise<void> {
  const error = await page.evaluate(
    (key) => Reflect.get(window, Symbol.for(key)) as string | undefined,
    preloadErrorKey,
  );
  if (error) throw new Error(`restore initial document state: ${error}`);
}

async function addPreloadScript(cdp: CDPSession, source: string): Promise<string> {
  const added = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source })) as {
    identifier?: string;
  };
  if (!added.identifier) throw new Error("browser omitted the preload script identifier");
  return added.identifier;
}

async function createTarget(
  context: BrowserContext,
  target: Target,
  opener?: Page,
): Promise<CreatedTarget> {
  const page = opener ? await createPopup(opener) : await context.newPage();

  try {
    const { cdp, id } = await cdpForPage(context, page);
    await cdp.send("Page.enable");

    const sessionStorageScripts = [];
    for (const state of target.sessionStorage ?? []) {
      const origin = canonicalOrigin(state.origin)!;
      const source = sessionStorageSource({ ...state, origin });
      sessionStorageScripts.push({
        origin,
        source,
        identifier: await addPreloadScript(cdp, source),
      });
    }

    const targetScript = await addPreloadScript(
      cdp,
      targetPreloadSource({
        url: target.url,
        windowName: target.documentState?.windowName,
      }),
    );

    await page.goto(target.url, { waitUntil: "commit", timeout: minute });
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: targetScript });
    await checkPreload(page);

    const historyState = target.documentState?.historyState;
    if (historyState !== undefined && page.url() === new URL(target.url).href) {
      const error = (await page.evaluate(targetHistoryStateSource(historyState))) as
        | string
        | undefined;
      if (error) throw new Error(`restore initial document state: ${error}`);
    }

    await page.waitForLoadState("domcontentloaded", { timeout: minute });
    await restoreDocument(page, target);

    // Session storage for origins that already loaded is in place. The rest is handed back
    // so Go can keep injecting it until those origins first load in this target.
    const tree = (await cdp.send("Page.getFrameTree")) as { frameTree: FrameTree };
    const loaded = frameOrigins(tree.frameTree);
    const sources: Record<string, string> = {};
    for (const script of sessionStorageScripts) {
      if (loaded.has(script.origin)) {
        await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: script.identifier,
        });
      } else {
        sources[script.origin] = script.source;
      }
    }

    return { page, id, sources };
  } catch (error) {
    await page.close().catch(() => undefined);
    throw error;
  }
}

function frameOrigins(tree: FrameTree, origins = new Set<string>()): Set<string> {
  const origin = urlOrigin(tree.frame.url);
  if (origin) origins.add(origin);
  for (const child of tree.childFrames ?? []) frameOrigins(child, origins);
  return origins;
}

// Removes what the target payload left on the page for the worker.
async function removePageKeys(page: Page): Promise<void> {
  await page
    .evaluate(
      (keys) => {
        for (const key of keys) Reflect.deleteProperty(window, Symbol.for(key));
      },
      [windowOpenKey, preloadErrorKey],
    )
    .catch(() => undefined);
}

async function createPopup(opener: Page): Promise<Page> {
  const cdp = await opener.context().newCDPSession(opener);
  try {
    const [popup, evaluation] = await Promise.all([
      opener.waitForEvent("popup", { timeout: 15_000 }),
      cdp.send("Runtime.evaluate", {
        expression: `globalThis[Symbol.for(${JSON.stringify(windowOpenKey)})]("about:blank", "_blank") !== null`,
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

export async function restoreTargets(
  context: BrowserContext,
  browserCDP: CDPSession,
  targets: Target[],
): Promise<TargetResult> {
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

  const created = new Map<number, CreatedTarget>();
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
      if (Object.keys(made.sources).length > 0) {
        result.sessionStorageSources[made.id] = made.sources;
      }
      progress = true;
    }

    if (!progress) throw new Error("initial target opener graph could not be resolved");
  }

  await Promise.all([...created.values()].map((target) => removePageKeys(target.page)));

  for (const id of existingIDs) {
    await browserCDP.send("Target.closeTarget", { targetId: id });
  }

  return result;
}
