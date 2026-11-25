import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Cdp from "../src/cdp.ts";
import * as Mcp from "../src/mcp.ts";
import { directory, run } from "../src/process.ts";
import { chromium } from "../src/programs.ts";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import { until } from "../src/wait.ts";
import { dataPage, inTab, openByAutomation, tabsOfAutomation } from "../src/workbench.ts";

/** The session's extension's id, which follows from the key in its manifest. */
const EXTENSION = "imdifnnggmlpoochobfcpghdppldpmjl";

/** What the runner logs of a page it opens again, for the extension did not move it. */
const OPENED_AGAIN = "did not give it one of its own";

const Targets = Schema.Struct({
  targetInfos: Schema.Array(
    Schema.Struct({ targetId: Schema.String, type: Schema.String, url: Schema.String }),
  ),
});

const Manifest = Schema.fromJsonString(Schema.Struct({ key: Schema.String }));

const Shot = Schema.Array(Schema.Struct({ type: Schema.String }));

const PRESSED = dataPage(`
  <title>Pressed</title>
  <body style="margin:0">
    <button id="press" style="position:absolute;left:100px;top:100px;width:300px;height:200px">press</button>
    <script>
      window.pressed = 0;
      document.addEventListener("pointerdown", () => (window.pressed += 1));
    </script>
  </body>
`);

/**
 * A directory whose profile an earlier build's extension ran in, as a profile from a
 * snapshot of an older session has: the extension's id, with a worker of another name.
 */
const earlier = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* directory;
  const ours = yield* path.fromFileUrl(
    new URL("../../crates/runner/extension/manifest.json", import.meta.url),
  );
  const { key } = yield* Schema.decodeUnknownEffect(Manifest)(yield* fs.readFileString(ours));
  const extension = `${dir}/earlier-extension`;
  yield* fs.makeDirectory(extension, { recursive: true });
  yield* fs.writeFileString(
    `${extension}/manifest.json`,
    JSON.stringify({
      manifest_version: 3,
      name: "An earlier build's",
      version: "1.0.0",
      key,
      permissions: ["tabs", "storage"],
      background: { service_worker: "service_worker.js", type: "module" },
    }),
  );
  yield* fs.writeFileString(
    `${extension}/service_worker.js`,
    "chrome.tabs.onCreated.addListener(() => {});\n",
  );
  const profile = `${dir}/session/profile`;
  yield* fs.makeDirectory(profile, { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* run(yield* chromium, [
        "--headless=new",
        "--no-sandbox",
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "--no-first-run",
        "about:blank",
      ]);
      const endpoint = yield* until(
        "the earlier browser serving DevTools",
        Effect.sync(() => /DevTools listening on (ws:\/\/\S+)/u.exec(browser.said())?.[1]),
        "30 seconds",
      );
      const cdp = yield* Cdp.connect(endpoint);
      yield* until(
        "the earlier build's worker running",
        cdp
          .call("Target.getTargets", {}, Targets)
          .pipe(
            Effect.map(({ targetInfos }) =>
              targetInfos.some(
                (target) =>
                  target.type === "service_worker" &&
                  target.url === `chrome-extension://${EXTENSION}/service_worker.js`,
              ),
            ),
          ),
        "30 seconds",
      );
      // The browser writes its profile out as it closes, and takes its lock last.
      yield* Effect.ignore(cdp.call("Browser.close"));
      yield* until(
        "the earlier browser leaving the profile",
        fs.readLink(`${profile}/SingletonLock`).pipe(
          Effect.as(false),
          Effect.orElseSucceed(() => true),
        ),
        "30 seconds",
      );
    }),
  );
  return dir;
});

const fromEarlier = Layer.effect(
  Runner.Runner,
  Effect.gen(function* () {
    const dir = yield* earlier;
    return yield* Runner.start({ dir, features: ["sound", "mcp", "cdp"] });
  }),
);

suite(fromEarlier)("a profile an earlier build's extension ran in", (it) => {
  it.effect("the session's extension takes over from the earlier one, and moves new tabs", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const mcp = yield* Mcp.connect(runner.url, runner.token);
      const first = yield* openByAutomation(mcp, PRESSED);
      const second = yield* openByAutomation(mcp, PRESSED);
      expect(second).not.toBe(first);
      const tabs = (yield* runner.targets).map((target) => target.tab);
      expect(tabs).toContain(first);
      expect(tabs).toContain(second);
      expect(runner.said()).not.toContain(OPENED_AGAIN);
    }),
  );
});

const fresh = Runner.layer({ features: ["mcp", "cdp"] });

suite(fresh)("a tab the session's extension leaves in another's window", (it) => {
  let first: number;

  it.effect("is opened again in a window of its own", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const mcp = yield* Mcp.connect(runner.url, runner.token);
      // Automation knows of a tab once it has listed it.
      const [listed] = yield* tabsOfAutomation(mcp);
      first = listed?.tab ?? 0;
      yield* mcp.call("navigate", { tab: first, url: PRESSED });

      // The extension gives no tab a window from here on: each window it would open is
      // named by a nonce first.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const cdp = yield* runner.cdp;
          const { targetInfos } = yield* cdp.call("Target.getTargets", {}, Targets);
          const worker = targetInfos.find(
            (target) =>
              target.type === "service_worker" &&
              target.url.startsWith(`chrome-extension://${EXTENSION}/`),
          );
          expect(worker).toBeDefined();
          const attached = yield* cdp.attach(worker?.targetId ?? "");
          yield* attached.evaluate(
            `(crypto.randomUUID = () => { throw new Error("no window, as the check has it"); }, 1)`,
          );
        }),
      );

      const opened = yield* openByAutomation(mcp, PRESSED);
      expect(opened).not.toBe(first);
      expect(runner.said()).toContain(OPENED_AGAIN);
      const tabs = (yield* runner.targets).map((target) => target.tab);
      expect(tabs).toHaveLength(2);
      expect(tabs).toEqual(expect.arrayContaining([first, opened]));
    }),
  );

  it.effect("the tab whose window it was in is shown and pressed again", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const mcp = yield* Mcp.connect(runner.url, runner.token);
      const shot = yield* mcp.content("screenshot", { tab: first });
      expect(Schema.decodeUnknownSync(Shot)(shot).some((part) => part.type === "image")).toBe(true);
      yield* mcp.call("click", { tab: first, selector: "#press" });
      expect(yield* inTab(mcp, first, "window.pressed")).toBe(1);
    }),
  );
});
