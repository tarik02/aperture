import { Effect } from "effect";
import { Playwright } from "effect-playwright";
import {
  cdpForPage,
  makeCdp,
  restoreError,
  type Cdp,
  type FrameTree,
  type TargetInfo,
} from "./cdp.js";
import { preloadErrorKey, windowOpenKey } from "./browser/page-keys.js";
import { PayloadSource } from "./payload-source.js";
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
  page: Playwright.Page;
  id: string;
  sources: Record<string, string>;
}

// Fails the target when the preload could not apply history state or window.name.
const checkPreload = Effect.fnUntraced(function* (page: Playwright.Page) {
  const error = yield* page.evaluate(
    (key) => Reflect.get(window, Symbol.for(key)) as string | undefined,
    preloadErrorKey,
  );
  if (error) return yield* restoreError(`restore initial document state: ${error}`);
});

const addPreloadScript = Effect.fnUntraced(function* (cdp: Cdp, source: string) {
  const added = yield* cdp.send<{ identifier?: string }>("Page.addScriptToEvaluateOnNewDocument", {
    source,
  });
  if (!added.identifier) {
    return yield* restoreError("browser omitted the preload script identifier");
  }
  return added.identifier;
});

const createTarget = Effect.fnUntraced(function* (
  context: Playwright.BrowserContext,
  target: Target,
  opener?: Playwright.Page,
) {
  const payloads = yield* PayloadSource;
  const page = opener ? yield* createPopup(opener) : yield* context.newPage;

  return yield* Effect.gen(function* () {
    const { cdp, id } = yield* cdpForPage(page);
    yield* cdp.send("Page.enable");

    const sessionStorageScripts = [];
    for (const state of target.sessionStorage ?? []) {
      const origin = canonicalOrigin(state.origin)!;
      const source = payloads.sessionStorage({ ...state, origin });
      sessionStorageScripts.push({
        origin,
        source,
        identifier: yield* addPreloadScript(cdp, source),
      });
    }

    const targetScript = yield* addPreloadScript(
      cdp,
      payloads.target({
        url: target.url,
        windowName: target.documentState?.windowName,
        historyState: target.documentState?.historyState,
      }),
    );

    yield* page.goto(target.url, { waitUntil: "domcontentloaded", timeout: minute });
    yield* cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: targetScript });
    yield* checkPreload(page);
    yield* restoreDocument(page, target);

    // Session storage for origins that already loaded is in place. The rest is handed back
    // so Go can keep injecting it until those origins first load in this target.
    const tree = yield* cdp.send<{ frameTree: FrameTree }>("Page.getFrameTree");
    const loaded = frameOrigins(tree.frameTree);
    const sources: Record<string, string> = {};
    for (const script of sessionStorageScripts) {
      if (loaded.has(script.origin)) {
        yield* cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: script.identifier,
        });
      } else {
        sources[script.origin] = script.source;
      }
    }

    return { page, id, sources } satisfies CreatedTarget;
  }).pipe(Effect.onError(() => Effect.ignore(page.close)));
});

function frameOrigins(tree: FrameTree, origins = new Set<string>()): Set<string> {
  const origin = urlOrigin(tree.frame.url);
  if (origin) origins.add(origin);
  for (const child of tree.childFrames ?? []) frameOrigins(child, origins);
  return origins;
}

// Removes what the target payload left on the page for the worker.
const removePageKeys = (page: Playwright.Page) =>
  page
    .evaluate(
      (keys) => {
        for (const key of keys) Reflect.deleteProperty(window, Symbol.for(key));
      },
      [windowOpenKey, preloadErrorKey],
    )
    .pipe(Effect.ignore);

const createPopup = Effect.fnUntraced(function* (opener: Playwright.Page) {
  const cdp = yield* Effect.acquireRelease(
    opener.use((raw) => raw.context().newCDPSession(raw)).pipe(Effect.map(makeCdp)),
    (cdp) => Effect.ignore(cdp.detach),
  );
  const [popup, evaluation] = yield* Effect.all(
    [
      opener.use((raw) => raw.waitForEvent("popup", { timeout: 15_000 })),
      cdp.send<{ result?: { value?: boolean }; exceptionDetails?: unknown }>("Runtime.evaluate", {
        expression: `globalThis[Symbol.for(${JSON.stringify(windowOpenKey)})]("about:blank", "_blank") !== null`,
        returnByValue: true,
        userGesture: true,
      }),
    ],
    { concurrency: "unbounded" },
  );
  if (evaluation.exceptionDetails || !evaluation.result?.value) {
    return yield* restoreError("browser rejected the initial popup target");
  }
  return Playwright.makePage(popup);
}, Effect.scoped);

export const restoreTargets = Effect.fnUntraced(function* (
  context: Playwright.BrowserContext,
  browserCDP: Cdp,
  targets: readonly Target[],
) {
  const result: TargetResult = {
    targetIds: [],
    activeIndex: targets.findIndex((item) => item.active),
    sessionStorageSources: {},
  };
  if (targets.length === 0) return result;

  const existing = yield* browserCDP.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
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

      const made = yield* createTarget(context, target, opener);
      created.set(index, made);
      result.targetIds[index] = made.id;
      if (Object.keys(made.sources).length > 0) {
        result.sessionStorageSources[made.id] = made.sources;
      }
      progress = true;
    }

    if (!progress) return yield* restoreError("initial target opener graph could not be resolved");
  }

  yield* Effect.forEach(created.values(), (target) => removePageKeys(target.page), {
    concurrency: "unbounded",
    discard: true,
  });

  for (const id of existingIDs) {
    yield* browserCDP.send("Target.closeTarget", { targetId: id });
  }

  return result;
});
