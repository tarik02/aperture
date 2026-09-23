import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { cdpForPage, type FrameTree, type TargetInfo } from "./cdp.js";
import { sessionStorageSource, targetStateSource } from "./payload-source.js";
import { canonicalOrigin, type Target } from "./schema.js";

const tabWindowEnforcerOrigin = "chrome-extension://imdifnnggmlpoochobfcpghdppldpmjl/";
const minute = 60_000;

export interface TargetResult {
  targetIds: string[];
  activeIndex: number;
  sessionStorageSources: Record<string, Record<string, string>>;
}

interface PreloadScript {
  identifier: string;
  source: string;
}

interface CreatedTarget {
  page: Page;
  id: string;
  sources: Record<string, string>;
}

interface NavigationResult {
  status: "succeeded" | "failed";
  error?: string;
}

async function waitForNavigation(page: Page, documentState: boolean): Promise<void> {
  const ready = await page.waitForFunction(
    (expectDocumentState) => {
      if (location.href === "about:blank") return false;
      if (!expectDocumentState) return { status: "succeeded" };

      const marker = Reflect.get(window, Symbol.for("aperture.initial-document-state")) as
        | NavigationResult
        | undefined;
      return marker?.status === "succeeded" || marker?.status === "failed" ? marker : false;
    },
    documentState,
    { timeout: minute },
  );

  try {
    const result = (await ready.jsonValue()) as NavigationResult;
    if (result.status === "failed") {
      throw new Error(`restore initial document state: ${result.error}`);
    }
  } finally {
    await ready.dispose().catch(() => undefined);
  }
}

async function createTarget(
  context: BrowserContext,
  target: Target,
  opener?: Page,
): Promise<CreatedTarget> {
  const page = opener ? await createPopup(opener) : await context.newPage();
  const scripts: Record<string, PreloadScript> = {};

  try {
    const { cdp, id } = await cdpForPage(context, page);
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

    await waitForNavigation(page, target.documentState != null);
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

  for (const id of existingIDs) {
    await browserCDP.send("Target.closeTarget", { targetId: id });
  }

  return result;
}
