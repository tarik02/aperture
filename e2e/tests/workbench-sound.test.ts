import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Mcp from "../src/mcp.ts";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import { type Page, ready, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import {
  appears,
  clickPicture,
  comes,
  dataPage,
  EVERY_FEATURE,
  has,
  keepErrors,
  loggedErrors,
  openByAutomation,
  selectTab,
} from "../src/workbench.ts";

const session = Layer.mergeAll(Runner.layer({ features: EVERY_FEATURE }), ViewerLive.layer);

const TONE = `
  const context = new AudioContext();
  const tone = context.createOscillator();
  tone.frequency.value = 440;
  tone.connect(context.destination);
  tone.start();
`;

const SOUNDING = dataPage(`
  <title>Sound check</title>
  <body style="margin:0">
    <button style="position:absolute;left:100px;top:500px;font-size:30px" onclick="${TONE}">tone</button>
  </body>
`);

/** A point on the page's button, in the tab's logical pixels. */
const BUTTON = { x: 130, y: 518 };

suite(session)("the workbench's sound", (it) => {
  let page: Page;
  let sounding: number;
  let soundButton: string;

  it.effect("a tab that plays tells so, and its tab shows it", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      const mcp = yield* Mcp.connect(runner.url, runner.token);
      page = yield* viewer.open(runner.page(), { scheme: "light" });
      yield* ready(page);
      yield* keepErrors(page);
      sounding = yield* openByAutomation(mcp, SOUNDING);
      soundButton = `[data-browser-tab][data-tab="${sounding}"] [data-browser-tab-sound]`;
      yield* page.until(`!!document.querySelector('[data-browser-tab][data-tab="${sounding}"]')`);
      expect(yield* selectTab(page, sounding)).toBe(true);
      yield* page.until("document.querySelector('[data-aperture-surface=video]').videoWidth > 0");

      yield* clickPicture(page, BUTTON.x, BUTTON.y);
      const plays = yield* comes(
        page,
        `s.targets.find((target) => target.tab === ${sounding}).sounds === true`,
      );
      expect(plays).toBe(true);
      expect(yield* appears(page, soundButton)).toBe(true);
      expect(yield* snapshot(page, "s.muted")).toEqual([]);
    }),
  );

  it.effect("the tab's sound button mutes it, and says so", () =>
    Effect.gen(function* () {
      yield* page.click(soundButton);
      expect(yield* comes(page, `s.muted.includes(${sounding})`)).toBe(true);
      const told = yield* page.evaluate(
        `document.querySelector('${soundButton}')?.dataset.browserTabSound`,
      );
      expect(told).toBe("muted");
    }),
  );

  it.effect("and lets it be heard again", () =>
    Effect.gen(function* () {
      yield* page.click(soundButton);
      expect(yield* comes(page, "s.muted.length === 0")).toBe(true);
    }),
  );

  it.effect("the toolbar has no sound button of its own", () =>
    Effect.gen(function* () {
      expect(yield* has(page, "[data-workbench-sound]")).toBe(false);
    }),
  );

  it.effect("the page threw nothing and logged no error", () =>
    Effect.gen(function* () {
      expect(page.errors()).toEqual([]);
      expect(yield* loggedErrors(page)).toEqual([]);
    }),
  );
});
