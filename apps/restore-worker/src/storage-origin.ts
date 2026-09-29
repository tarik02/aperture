import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { Playwright } from "effect-playwright";
import type { Frame, Route } from "playwright-core";
import { restoreError, type RestoreError } from "./cdp.js";
import { urlOrigin } from "./schema.js";

const minute = 60_000;
const emptyDocument = "<!doctype html><meta charset=utf-8><title>Aperture storage</title>";

function documentForChild(origin: string): string {
  const escaped = origin.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<!doctype html><meta charset=utf-8><title>Aperture storage partition</title><iframe src="${escaped}"></iframe>`;
}

export const navigateIsolatedOrigin = Effect.fnUntraced(function* (
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
  // Chromium upgrades top-level GET navigations from http to https, and when the
  // upgrade fails it loads the real http site, bypassing request interception.
  // It never upgrades POST navigations, so the helper submits a form instead of
  // navigating. The timer lets the evaluation return before the page unloads.
  yield* page.use((raw) =>
    raw.evaluate((url) => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = url;
      document.documentElement.append(form);
      setTimeout(() => form.submit());
    }, chain[0]),
  );
  yield* Deferred.await(finished).pipe(
    Effect.timeoutOrElse({
      duration: minute,
      orElse: () =>
        Effect.fail(
          restoreError("browser did not request the isolated origin document within 1 minute"),
        ),
    }),
  );
});

export function frameMatchesChain(frame: Frame, chain: readonly string[]): boolean {
  const origins: (string | null)[] = [];
  for (let current: Frame | null = frame; current; current = current.parentFrame()) {
    origins.unshift(urlOrigin(current.url()));
  }

  return origins.length === chain.length && origins.every((value, index) => value === chain[index]);
}
