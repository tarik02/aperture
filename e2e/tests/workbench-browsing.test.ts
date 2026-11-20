import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Mcp from "../src/mcp.ts";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import { type Page, ready, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens } from "../src/wait.ts";
import {
  arrives,
  askedOfOthers,
  clickPicture,
  closeTab,
  comes,
  dataPage,
  EVERY_FEATURE,
  goTo,
  inTab,
  keepErrors,
  loggedErrors,
  openByAutomation,
  selectTab,
  tabNumbers,
  tabsOfAutomation,
} from "../src/workbench.ts";

const session = Layer.mergeAll(Runner.layer({ features: EVERY_FEATURE }), ViewerLive.layer);

const FORM = dataPage(`
  <title>Workbench check</title>
  <body style="margin:0">
    <input id="field" style="position:absolute;left:100px;top:100px;width:600px;height:60px;font-size:30px">
  </body>
`);

/** A point within the form's one field, in the tab's logical pixels. */
const FIELD = { x: 400, y: 130 };

const titleOf = (tab: number) => `s.targets.find((target) => target.tab === ${tab})?.title`;

suite(session)("the workbench, for browsing", (it) => {
  let page: Page;
  let mcp: Mcp.Mcp;
  let initial: readonly string[];
  let typed: number;
  let form: number;

  it.effect("connects and shows the watched tab as video over WebRTC", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      mcp = yield* Mcp.connect(runner.url, runner.token);
      initial = (yield* tabsOfAutomation(mcp)).map((tab) => tab.target);
      page = yield* viewer.open(runner.page(), { scheme: "light" });
      yield* ready(page);
      yield* keepErrors(page);

      expect(yield* snapshot(page, "s.connection.state")).toBe("open");
      expect(yield* snapshot(page, "s.selected !== undefined && s.targets.length > 0")).toBe(true);
      const overWebRtc = yield* comes(
        page,
        "s.picture.way === 'video' && s.picture.rtc === 'connected'",
      );
      expect(overWebRtc).toBe(true);
      const hasPicture = yield* happens(
        page.evaluate("document.querySelector('[data-aperture-surface=video]').videoWidth > 0"),
      );
      expect(hasPicture).toBe(true);
    }),
  );

  it.effect("the page gives the session's client, and its surfaces are found", () =>
    Effect.gen(function* () {
      const client = yield* page.evaluate(
        "typeof apertureSession.attach === 'function' && typeof apertureSession.getSnapshot === 'function'",
      );
      expect(client).toBe(true);
      const surfaces = yield* page.evaluate(
        "['video', 'canvas'].every((surface) => document.querySelector(`[data-aperture-surface=${surface}]`) !== null)",
      );
      expect(surfaces).toBe(true);
    }),
  );

  it.effect("the session tells what it offers", () =>
    Effect.gen(function* () {
      const offered = yield* snapshot(
        page,
        "s.features.sound.read && s.features.uploads.write && s.features.downloads.read",
      );
      expect(offered).toBe(true);
    }),
  );

  it.effect("the new tab button opens a tab, which whoever opened it watches", () =>
    Effect.gen(function* () {
      const before = yield* tabNumbers(page);
      yield* page.click('[aria-label="New tab"]');
      expect(yield* comes(page, `s.targets.length === ${before.length + 1}`)).toBe(true);
      typed = (yield* tabNumbers(page)).find((tab) => !before.includes(tab))!;
      expect(yield* comes(page, `s.selected === ${typed}`)).toBe(true);
    }),
  );

  it.effect("an address typed into the address bar is gone to, and the tab tells of it", () =>
    Effect.gen(function* () {
      yield* goTo(page, "example.com");
      expect(yield* arrives(page, typed, "https://example.com")).toBe(true);
      expect(yield* comes(page, `${titleOf(typed)} === "Example Domain"`)).toBe(true);
      const shown = yield* happens(
        page.evaluate(
          "document.querySelector('[data-workbench-address]').value.startsWith('https://example.com')",
        ),
      );
      expect(shown).toBe(true);
    }),
  );

  it.effect("a tab automation opens is heard of, and a click on it selects it", () =>
    Effect.gen(function* () {
      form = yield* openByAutomation(mcp, FORM);
      expect(yield* comes(page, `s.targets.some((target) => target.tab === ${form})`)).toBe(true);
      expect(yield* selectTab(page, form)).toBe(true);
    }),
  );

  it.effect("a click on the picture gives the session the keyboard, and typing lands", () =>
    Effect.gen(function* () {
      yield* page.until("document.querySelector('[data-aperture-surface=video]').videoWidth > 0");
      yield* clickPicture(page, FIELD.x, FIELD.y);
      const keyboard = yield* happens(
        page.evaluate("document.activeElement?.dataset.apertureSurface === 'keys'"),
      );
      expect(keyboard).toBe(true);

      yield* page.type("hello workbench");
      const landed = yield* happens(
        inTab(mcp, form, "document.getElementById('field').value").pipe(
          Effect.map((value) => value === "hello workbench"),
        ),
      );
      expect(landed).toBe(true);
    }),
  );

  it.effect("back and forward go along the tab's history", () =>
    Effect.gen(function* () {
      expect(yield* selectTab(page, typed)).toBe(true);
      yield* goTo(page, "example.org");
      expect(yield* arrives(page, typed, "https://example.org")).toBe(true);
      yield* page.until(`!document.querySelector('button[aria-label="Back"]').disabled`);

      yield* page.click('[aria-label="Back"]');
      expect(yield* arrives(page, typed, "https://example.com")).toBe(true);
      yield* page.until(`!document.querySelector('button[aria-label="Forward"]').disabled`);

      yield* page.click('[aria-label="Forward"]');
      expect(yield* arrives(page, typed, "https://example.org")).toBe(true);
    }),
  );

  it.effect("reload loads the page anew", () =>
    Effect.gen(function* () {
      yield* happens(
        inTab(mcp, typed, "document.readyState === 'complete' && (window.marked = 1)"),
      );
      yield* page.click('[aria-label="Reload"]');
      const anew = yield* happens(
        inTab(mcp, typed, "window.marked === undefined && document.readyState === 'complete'"),
      );
      expect(anew).toBe(true);
    }),
  );

  it.effect("a tab's close button closes it, until the tabs are as they were", () =>
    Effect.gen(function* () {
      expect(yield* closeTab(page, form)).toBe(true);
      expect(yield* closeTab(page, typed)).toBe(true);
      const left = (yield* tabsOfAutomation(mcp)).map((tab) => tab.target);
      expect(left).toEqual(initial);
    }),
  );

  it.effect("the page threw nothing, logged no error and asked nothing of other origins", () =>
    Effect.gen(function* () {
      expect(page.errors()).toEqual([]);
      expect(yield* loggedErrors(page)).toEqual([]);
      expect(yield* askedOfOthers(page)).toEqual([]);
    }),
  );
});
