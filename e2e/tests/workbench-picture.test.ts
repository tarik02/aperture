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
  clickItem,
  clickPicture,
  closeMenus,
  comes,
  dataPage,
  escape,
  EVERY_FEATURE,
  inTab,
  keepErrors,
  loggedErrors,
  menuItem,
  openByAutomation,
  openMenu,
  selectTab,
} from "../src/workbench.ts";

const session = Layer.mergeAll(Runner.layer({ features: EVERY_FEATURE }), ViewerLive.layer);

const FIELD = { left: 100, top: 100, width: 600, height: 60 };

const FORM = dataPage(`
  <title>Picture check</title>
  <body style="margin:0">
    <input id="field" style="position:absolute;left:${FIELD.left}px;top:${FIELD.top}px;width:${FIELD.width}px;height:${FIELD.height}px;font-size:30px">
  </body>
`);

const CANVAS = "document.querySelector('[data-aperture-surface=canvas]')";

/** The canvas's width, and how many of the pixels where the form's field is are not light. */
const drawnOnCanvas = (page: Page): Effect.Effect<{ width: number; dark: number }, Error> =>
  page.evaluate(
    `(() => {
      const canvas = ${CANVAS};
      const pixels = canvas
        .getContext("2d")
        .getImageData(${FIELD.left}, ${FIELD.top}, ${FIELD.width}, ${FIELD.height}).data;
      let dark = 0;
      for (let at = 0; at < pixels.length; at += 4) {
        // A canvas nothing was drawn on is transparent black, which is no picture.
        if (pixels[at + 3] === 255 && pixels[at] < 200) dark += 1;
      }
      return { width: canvas.width, dark };
    })()`,
  );

const status = (page: Page) => page.text("[data-picture-status]");

const fieldValue = (mcp: Mcp.Mcp, tab: number) =>
  inTab(mcp, tab, "document.getElementById('field').value");

/** Types into the form's field, and tells whether the field comes to say `whole`. */
const typeIntoField = (page: Page, mcp: Mcp.Mcp, tab: number, text: string, whole: string) =>
  Effect.gen(function* () {
    yield* clickPicture(page, FIELD.left + FIELD.width / 2, FIELD.top + FIELD.height / 2);
    yield* page.type(text);
    return yield* happens(fieldValue(mcp, tab).pipe(Effect.map((value) => value === whole)));
  });

const sizeOf = (tab: number) => `s.targets.find((target) => target.tab === ${tab})`;

suite(session)("the workbench's picture and viewport", (it) => {
  let page: Page;
  let mcp: Mcp.Mcp;
  let form: number;

  it.effect("the picture menu tells what the session sends", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      mcp = yield* Mcp.connect(runner.url, runner.token);
      page = yield* viewer.open(runner.page(), { scheme: "light" });
      yield* ready(page);
      yield* keepErrors(page);
      form = yield* openByAutomation(mcp, FORM);
      yield* page.until(`!!document.querySelector('[data-browser-tab][data-tab="${form}"]')`);
      expect(yield* selectTab(page, form)).toBe(true);
      yield* comes(page, "s.picture.way === 'video' && s.picture.rtc === 'connected'");
      yield* page.until("document.querySelector('[data-aperture-surface=video]').videoWidth > 0");
      expect(yield* typeIntoField(page, mcp, form, "hello workbench", "hello workbench")).toBe(
        true,
      );

      yield* openMenu(page, "[data-workbench-picture]", "Transport");
      const told = yield* happens(
        status(page).pipe(Effect.map((text) => /WebRTC · H\.264/u.test(text ?? ""))),
      );
      expect(told, yield* status(page)).toBe(true);
    }),
  );

  it.effect("frames come instead when chosen, and are drawn on the canvas", () =>
    Effect.gen(function* () {
      yield* clickItem(page, "Transport");
      yield* clickItem(page, "Frames");
      expect(yield* comes(page, "s.picture.way === 'frames'")).toBe(true);
      const drawn = yield* happens(
        page.evaluate(
          `${CANVAS}.width === innerWidth && ${CANVAS}.getBoundingClientRect().width > 0`,
        ),
      );
      expect(drawn).toBe(true);
      const told = yield* happens(
        status(page).pipe(Effect.map((text) => /Frames · H\.264/u.test(text ?? ""))),
      );
      expect(told, yield* status(page)).toBe(true);
    }),
  );

  it.effect("tiles come instead when chosen, and are drawn on the canvas", () =>
    Effect.gen(function* () {
      yield* clickItem(page, "Tiles");
      expect(yield* comes(page, "s.picture.way === 'tiles'")).toBe(true);
      const window: number = yield* page.evaluate("innerWidth");
      const drawn = yield* happens(
        drawnOnCanvas(page).pipe(Effect.map(({ width, dark }) => width === window && dark > 0)),
      );
      expect(drawn, JSON.stringify(yield* drawnOnCanvas(page))).toBe(true);
      yield* closeMenus(page);
    }),
  );

  it.effect("typing lands with the canvas as it does with the video", () =>
    Effect.gen(function* () {
      expect(yield* typeIntoField(page, mcp, form, " x", "hello workbench x")).toBe(true);
    }),
  );

  it.effect("the picture goes back to WebRTC when chosen", () =>
    Effect.gen(function* () {
      yield* openMenu(page, "[data-workbench-picture]", "Transport");
      yield* clickItem(page, "Transport");
      yield* clickItem(page, "WebRTC");
      const back = yield* comes(page, "s.picture.way === 'video' && s.picture.rtc === 'connected'");
      expect(back).toBe(true);
      yield* closeMenus(page);
    }),
  );

  it.effect("a size chosen from the menu is the tab's size", () =>
    Effect.gen(function* () {
      yield* openMenu(page, "[data-workbench-picture]", "Size");
      yield* clickItem(page, "Size");
      yield* clickItem(page, "1024 × 768");
      const resized = yield* comes(
        page,
        `${sizeOf(form)}.width === 1024 && ${sizeOf(form)}.height === 768`,
      );
      expect(resized).toBe(true);

      yield* clickItem(page, "1280 × 720");
      const again = yield* comes(
        page,
        `${sizeOf(form)}.width === 1280 && ${sizeOf(form)}.height === 720`,
      );
      expect(again).toBe(true);
      // Leaves the submenu, and the menu open.
      yield* escape(page);
      yield* Effect.sleep(200);
    }),
  );

  it.effect("a scale chosen from the menu is the tab's, and the picture keeps its size", () =>
    Effect.gen(function* () {
      yield* clickItem(page, "Scale");
      yield* clickItem(page, "2x");
      expect(yield* comes(page, `${sizeOf(form)}.scale === 2`)).toBe(true);
      yield* page.until(
        "document.querySelector('[data-aperture-surface=video]').videoWidth > 1280",
      );
      const picture = yield* page.box("[data-aperture-surface=video]");
      expect(picture.width).toBeLessThanOrEqual(1280);

      yield* clickItem(page, "1x");
      expect(yield* comes(page, `${sizeOf(form)}.scale === 1`)).toBe(true);
      yield* escape(page);
      yield* Effect.sleep(200);
    }),
  );

  it.effect("a tab that fits the window has the stage's size, until fitting is turned off", () =>
    Effect.gen(function* () {
      yield* clickItem(page, "Fit to this window");
      const stage = yield* page.box("[data-aperture-stage]");
      const fits = yield* comes(
        page,
        `s.fit && ${sizeOf(form)}.width === ${Math.round(stage.width)} && ${sizeOf(form)}.height === ${Math.round(stage.height)}`,
      );
      expect(fits).toBe(true);

      yield* clickItem(page, "Fit to this window");
      expect(yield* comes(page, "!s.fit")).toBe(true);
      expect(yield* page.evaluate(`!!(${menuItem("Fit to this window")})`)).toBe(true);
      yield* closeMenus(page);

      yield* page.evaluate("apertureSession.setViewport({ width: 1280, height: 720, scale: 1 })");
      const restored = yield* comes(
        page,
        `${sizeOf(form)}.width === 1280 && ${sizeOf(form)}.height === 720`,
      );
      expect(restored).toBe(true);
    }),
  );

  it.effect("the page threw nothing and logged no error", () =>
    Effect.gen(function* () {
      expect(page.errors()).toEqual([]);
      expect(yield* loggedErrors(page)).toEqual([]);
      expect(yield* snapshot(page, "s.connection.state")).toBe("open");
    }),
  );
});
