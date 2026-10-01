import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { ChildProcess } from "effect/process";
import { Playwright } from "effect-playwright";
import { describe, expect, it } from "vite-plus/test";
import { openStorageKeys } from "./storage-inventory.js";
import { frameMatchesChain, navigateIsolatedOrigin } from "./storage-origin.js";

// Chromium runs the way the session wrapper starts it, not through Playwright's
// launcher, whose default flags turn off HTTPS upgrades among others. No request
// reaches the network: pages are served by routes, anything else fails to resolve.
const withBrowser = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const profile = yield* fs.makeTempDirectoryScoped();
  yield* ChildProcess.make("chromium", [
    "--headless",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);
  const activePort = yield* fs
    .readFileString(`${profile}/DevToolsActivePort`)
    .pipe(Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }));
  const playwright = yield* Playwright.Playwright;
  const browser = yield* playwright.connectCDPScoped(
    `http://127.0.0.1:${activePort.split("\n")[0]}`,
  );
  return browser.contexts()[0];
});

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Playwright.Playwright | NodeServices.NodeServices | import("effect/Scope").Scope
  >,
) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(Layer.merge(Playwright.layer, NodeServices.layer))),
  );

const jira = (body: string) =>
  `<!doctype html><script>localStorage.setItem("jira", "1");</script>${body}`;
const forge = `<!doctype html><script>localStorage.setItem("forge", "1");</script>`;

/** Opens a user tab on http://jira.test whose frames load from routes. */
const openJira = Effect.fnUntraced(function* (context: Playwright.BrowserContext, body: string) {
  const page = yield* context.newPage;
  yield* page.use((raw) =>
    raw.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: new URL(route.request().url()).hostname === "jira.test" ? jira(body) : forge,
      }),
    ),
  );
  yield* page.goto("http://jira.test/", { waitUntil: "load" });
  return page;
});

describe("storage export", { timeout: 120_000 }, () => {
  it("inventories open tabs next to sandboxed frames and blank tabs", () =>
    run(
      Effect.gen(function* () {
        const context = yield* withBrowser();
        yield* openJira(
          context,
          `<iframe src="http://forge.test/"></iframe>
           <iframe sandbox="allow-scripts" src="http://ads.test/"></iframe>`,
        );

        const keys = yield* openStorageKeys(context);
        expect([...keys].sort()).toEqual([
          "http://forge.test/^0http://jira.test",
          "http://jira.test/",
        ]);
      }),
    ));

  it("inventories open tabs whose frames keep being replaced", () =>
    run(
      Effect.gen(function* () {
        const context = yield* withBrowser();
        for (const blank of context.pages()) yield* blank.close;
        yield* openJira(
          context,
          `<script>
            const add = () => {
              const frame = document.createElement("iframe");
              frame.src = "http://forge.test/?" + Math.random();
              document.body.append(frame);
            };
            addEventListener("load", () => {
              for (let i = 0; i < 4; i++) add();
              setInterval(() => { document.querySelector("iframe").remove(); add(); }, 5);
            });
          </script>`,
        );

        for (let attempt = 0; attempt < 30; attempt++) {
          const keys = yield* openStorageKeys(context);
          expect(keys).toContain("http://jira.test/");
        }
      }),
    ));

  it("serves the helper chain of an http origin Chromium would upgrade to https", () =>
    run(
      Effect.gen(function* () {
        const context = yield* withBrowser();
        const page = yield* context.newPage;
        const chain = ["http://example.com", "http://forge.test"];

        yield* navigateIsolatedOrigin(page, chain);
        const frame = yield* page.use(
          async (raw) =>
            raw.frames().find((frame) => frameMatchesChain(frame, chain)) ??
            (await raw.waitForEvent("framenavigated", {
              predicate: (frame) => frameMatchesChain(frame, chain),
              timeout: 15_000,
            })),
        );
        expect(yield* page.use(() => frame.evaluate(() => origin))).toBe("http://forge.test");
      }),
    ));
});
