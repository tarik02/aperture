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
  appears,
  buttonWithin,
  clickElement,
  clickItem,
  dataPage,
  escape,
  EVERY_FEATURE,
  has,
  hasItem,
  keepErrors,
  leaves,
  loggedErrors,
  menuItem,
  openByAutomation,
  selectTab,
} from "../src/workbench.ts";

const session = Layer.mergeAll(Runner.layer({ features: EVERY_FEATURE }), ViewerLive.layer);

const FORM = dataPage(`
  <title>Sample</title>
  <body style="font:24px sans-serif;padding:60px">
    <h1>Sample form</h1>
    <input id="field" style="font-size:28px;width:500px">
    <br><br>
    <button id="send" style="font-size:28px" onclick="document.body.append(Object.assign(document.createElement('p'), { textContent: 'done' }))">Send</button>
  </body>
`);

const GALLERY = "[data-kept-gallery]";
const VIDEO = `document.querySelector("${GALLERY} video")`;

/** The recordings as the session lists them, told whether `holds` of the list `all`. */
const recordings = (page: Page, holds: string) =>
  page.evaluate(`apertureSession.recordings.list().then((all) => ${holds})`);

/** Opens the recording menu unless it is open. */
const openRecordingMenu = (page: Page) =>
  Effect.gen(function* () {
    if (!(yield* hasItem(page, "Screenshot"))) {
      yield* page.click("[data-workbench-recording]");
    }
    yield* page.until(`!!(${menuItem("Screenshot")})`);
    yield* Effect.sleep(300);
  });

interface Sizes {
  readonly dialog: readonly [number, number];
  readonly shown: readonly [number, number];
}

/** The sizes of the gallery's dialog and of what it shows. */
const gallerySizes = (page: Page): Effect.Effect<Sizes, Error> =>
  page.evaluate(
    `(() => {
      const size = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return [Math.round(rect.width), Math.round(rect.height)];
      };
      return { dialog: size("${GALLERY}"), shown: size("[data-kept-shown]") };
    })()`,
  );

/** Whether the bars over the gallery's video are all in this state. */
const barsAre = (page: Page, state: "shown" | "hidden") =>
  page.evaluate(
    `[...document.querySelectorAll("[data-kept-bars]")].every((bars) =>
      bars.dataset.keptBars === "${state}" &&
      (${state === "shown"} || Number(getComputedStyle(bars).opacity) < 0.2))`,
  );

const closeIsInHeader = (page: Page) =>
  page.evaluate(
    `(() => {
      const header = document.querySelector("${GALLERY} header").getBoundingClientRect();
      const close = document.querySelector("${GALLERY} [aria-label=Close]").getBoundingClientRect();
      return close.top >= header.top && close.bottom <= header.bottom;
    })()`,
  );

suite(session)("the workbench's recordings and what it keeps", (it) => {
  let page: Page;
  let mcp: Mcp.Mcp;
  let form: number;
  let withAutomation: string;
  let soughtTo: number;

  it.effect("'Record this tab' starts a recording, which the menu shows as running", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      mcp = yield* Mcp.connect(runner.url, runner.token);
      // Not fitted: the tab keeps one size, and so does the picture of what is recorded.
      page = yield* viewer.open(runner.page({ fit: "0" }), { scheme: "light" });
      yield* ready(page);
      yield* keepErrors(page);
      form = yield* openByAutomation(mcp, FORM);
      yield* page.until(`!!document.querySelector('[data-browser-tab][data-tab="${form}"]')`);
      expect(yield* selectTab(page, form)).toBe(true);
      yield* page.until("document.querySelector('[data-aperture-surface=video]').videoWidth > 0");

      yield* openRecordingMenu(page);
      yield* clickItem(page, "Record this tab");
      const started = yield* happens(
        recordings(page, "all.some((one) => one.state === 'recording')"),
      );
      expect(started).toBe(true);

      // A recording is of some length.
      yield* Effect.sleep(2500);
      yield* openRecordingMenu(page);
      expect(yield* hasItem(page, "Stop recording")).toBe(true);
    }),
  );

  it.effect("'Stop recording' stops it, and the finished recording is listed", () =>
    Effect.gen(function* () {
      yield* clickItem(page, "Stop recording");
      const stopped = yield* happens(
        recordings(page, "all.length > 0 && all.every((one) => one.state !== 'recording')"),
      );
      expect(stopped).toBe(true);
      yield* happens(
        recordings(page, "all.every((one) => one.edit === null || one.edit.state !== 'editing')"),
        60_000,
      );

      yield* openRecordingMenu(page);
      expect(yield* appears(page, "[data-kept=recording]")).toBe(true);
    }),
  );

  it.effect("a recording opens in the gallery, plays there and is served for download", () =>
    Effect.gen(function* () {
      yield* page.click("[data-kept=recording]");
      expect(yield* appears(page, `${GALLERY} video`)).toBe(true);
      expect(yield* happens(page.evaluate(`${VIDEO}.readyState >= 1`), 10_000)).toBe(true);

      const link: string = yield* page.evaluate(
        `[...document.querySelectorAll("${GALLERY} a")].find((one) => one.getAttribute("aria-label") === "Download").href`,
      );
      const status = yield* page.evaluate(
        `fetch(${JSON.stringify(link)}).then((answer) => answer.status)`,
      );
      expect(status).toBe(200);

      yield* escape(page);
      expect(yield* leaves(page, GALLERY)).toBe(true);
    }),
  );

  it.effect("the menu's 'Screenshot' takes one, which is kept", () =>
    Effect.gen(function* () {
      yield* openRecordingMenu(page);
      yield* clickItem(page, "Screenshot");
      expect(yield* appears(page, "[data-kept=screenshot]")).toBe(true);
    }),
  );

  it.effect("a recording of what automation did shows its calls and where the pointer moved", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const started = yield* runner.request("POST", "/recordings", {
        tab: form,
        idle: "speed",
        ripple: true,
      });
      withAutomation = started.body.id;
      // What automation does is some way into the recording, and apart.
      yield* Effect.sleep(1000);
      yield* mcp.call("click", { tab: form, selector: "#field" });
      yield* mcp.call("type", { tab: form, text: "hello from automation" });
      yield* Effect.sleep(4000);
      yield* mcp.call("click", { tab: form, selector: "#send" });
      yield* Effect.sleep(1000);
      yield* runner.request("POST", `/recordings/${withAutomation}/stop`);

      yield* openRecordingMenu(page);
      const kept = `[data-kept-id="${withAutomation}"]`;
      yield* page.until(
        `document.querySelector('${kept} [data-recording-state]')?.dataset.recordingState === 'Finished'`,
        60_000,
      );
      yield* page.click(kept);
      expect(yield* happens(page.evaluate(`${VIDEO}?.readyState >= 1`), 10_000)).toBe(true);
      expect(yield* appears(page, "[data-kept-call]")).toBe(true);
      expect(yield* has(page, "[data-kept-run]")).toBe(true);
    }),
  );

  it.effect("the gallery's dialog is the video's size, and the video keeps the tab's shape", () =>
    Effect.gen(function* () {
      const { dialog, shown } = yield* gallerySizes(page);
      expect(dialog).toEqual(shown);
      const shape: number = yield* snapshot(page, "watched.width / watched.height");
      expect(Math.abs(shown[0] / shown[1] - shape)).toBeLessThan(0.02);
      expect(yield* closeIsInHeader(page)).toBe(true);
    }),
  );

  it.effect("pointing at a call on the track names its tool", () =>
    Effect.gen(function* () {
      const call = yield* page.box("[data-kept-call]");
      yield* page.mouse("mouseMoved", call.x, call.y + 8);
      expect(yield* appears(page, "[data-kept-track-tip]")).toBe(true);
      const tip: string = yield* page.evaluate(
        "document.querySelector('[data-kept-track-tip]').innerText",
      );
      expect(tip).toMatch(/click|type/u);
    }),
  );

  it.effect("a click on the track seeks, and play plays from there", () =>
    Effect.gen(function* () {
      const track = yield* page.box("[data-kept-track]");
      const part = 0.12;
      yield* page.clickAt(track.left + track.width * part, track.y);
      const duration: number = yield* page.evaluate(`${VIDEO}.duration`);
      const sought = yield* happens(
        page.evaluate(`Math.abs(${VIDEO}.currentTime - ${duration * part}) < 0.3`),
        3000,
      );
      expect(sought, String(yield* page.evaluate(`${VIDEO}.currentTime`))).toBe(true);
      soughtTo = yield* page.evaluate(`${VIDEO}.currentTime`);

      yield* page.click(`${GALLERY} [aria-label=Play]`);
      const plays = yield* happens(page.evaluate(`${VIDEO}.currentTime > ${soughtTo + 0.3}`), 5000);
      expect(plays).toBe(true);
    }),
  );

  it.effect(
    "the bars leave while it plays and the pointer rests, and come back when it moves",
    () =>
      Effect.gen(function* () {
        yield* page.evaluate(`(${VIDEO}.currentTime = 0, true)`);
        yield* page.mouse("mouseMoved", 640, 300);
        expect(yield* happens(barsAre(page, "hidden"), 6000)).toBe(true);

        yield* page.mouse("mouseMoved", 650, 310);
        expect(yield* happens(barsAre(page, "shown"), 3000)).toBe(true);
        yield* page.evaluate(`${VIDEO}.pause()`);
      }),
  );

  it.effect("a screenshot chosen from the gallery's list is shown at its own size", () =>
    Effect.gen(function* () {
      yield* page.mouse("mouseMoved", 5, 5);
      yield* page.click("[data-kept-list-button]");
      yield* clickElement(page, buttonWithin("[data-kept-list]", "Screenshot"));
      yield* page.until("document.querySelector('[data-kept-shown=screenshot]')?.naturalWidth > 0");
      const sized = yield* happens(
        gallerySizes(page).pipe(
          Effect.map(({ dialog, shown }) => dialog[0] === shown[0] && dialog[1] === shown[1]),
        ),
        3000,
      );
      expect(sized, JSON.stringify(yield* gallerySizes(page))).toBe(true);
      expect(yield* has(page, "[data-kept-list]")).toBe(false);
    }),
  );

  it.effect("Escape closes the gallery, which shows what it showed until it is gone", () =>
    Effect.gen(function* () {
      yield* escape(page);
      const emptied = yield* page.evaluate(
        `!!document.querySelector("${GALLERY}") && !document.querySelector("[data-kept-shown]")`,
      );
      expect(emptied).toBe(false);
      expect(yield* leaves(page, GALLERY)).toBe(true);
    }),
  );

  it.effect("the page threw nothing and logged no error", () =>
    Effect.gen(function* () {
      expect(page.errors()).toEqual([]);
      expect(yield* loggedErrors(page)).toEqual([]);
    }),
  );
});
