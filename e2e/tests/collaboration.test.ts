import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Mcp from "../src/mcp.ts";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import { type Box, type Page, ready, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens } from "../src/wait.ts";
import {
  appears,
  clickItem,
  closeMenus,
  comes,
  dataPage,
  EVERY_FEATURE,
  has,
  hasItem,
  inTab,
  leaves,
  openByAutomation,
  openMenu,
} from "../src/workbench.ts";

const session = Layer.mergeAll(Runner.layer({ features: EVERY_FEATURE }), ViewerLive.layer);

/** A page that counts what its pointer does, for telling input from marks. */
const COUNTING = dataPage(`
  <title>Marks check</title>
  <body style="margin:0">
    <script>
      window.pointed = 0;
      for (const kind of ["mousemove", "mousedown", "mouseup"]) {
        addEventListener(kind, () => { window.pointed += 1; });
      }
    </script>
  </body>
`);

const POINTERS = "Show the others' pointers";

const pointerOf = (member: number) => `[data-member-pointer="${member}"]`;

/** How many pixels of the canvas of marks have anything drawn on them. */
const inked = (page: Page) =>
  page.evaluate(
    `(() => {
      const canvas = document.querySelector("[data-member-marks] canvas");
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let drawn = 0;
      for (let at = 3; at < pixels.length; at += 4) {
        if (pixels[at] > 0) drawn += 1;
      }
      return drawn;
    })()`,
    Schema.Number,
  );

/** Moves the pointer over the picture in two steps, to a place given from its middle. */
const pointAt = (page: Page, picture: Box, right: number, down: number) =>
  Effect.gen(function* () {
    yield* page.mouse("mouseMoved", picture.x + right - 20, picture.y + down - 10);
    yield* Effect.sleep("80 millis");
    yield* page.mouse("mouseMoved", picture.x + right, picture.y + down);
  });

/** Presses, drags down and to the right from left of the picture's middle, and lets go. */
const drawStroke = (page: Page, picture: Box) =>
  Effect.gen(function* () {
    const from = { x: picture.x - 80, y: picture.y - 40 };
    const steps = 12;
    yield* page.mouse("mouseMoved", from.x, from.y);
    yield* page.mouse("mousePressed", from.x, from.y, {
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (let step = 0; step <= steps; step += 1) {
      yield* page.mouse("mouseMoved", from.x + step * 12, from.y + step * 6, {
        button: "left",
        buttons: 1,
      });
      yield* Effect.sleep("30 millis");
    }
    yield* page.mouse("mouseReleased", from.x + steps * 12, from.y + steps * 6, {
      button: "left",
      clickCount: 1,
    });
  });

const togglePointers = (page: Page) =>
  Effect.gen(function* () {
    yield* openMenu(page, "[data-workbench-picture]", POINTERS);
    yield* clickItem(page, POINTERS);
    yield* Effect.sleep("200 millis");
    yield* closeMenus(page);
  });

const followedBy = (member: number) =>
  `s.presence.members.find((one) => one.id === ${member}).follows`;

suite(session)("two people in one session", (it) => {
  let ada: Page;
  let bob: Page;
  let mcp: Mcp.Mcp;
  let adaId: number;
  let bobId: number;
  let shared: number;
  let other: number;
  let picture: Box;
  let pointedBefore: unknown;

  const pointed = () => inTab(mcp, shared, "window.pointed");
  const whereBobSeesAda = () =>
    bob.evaluate(`document.querySelector('${pointerOf(adaId)}')?.style.transform ?? ""`);

  it.effect("one sees where the other points, with their name, and nobody their own", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      mcp = yield* Mcp.connect(runner.url, runner.token);
      shared = yield* openByAutomation(mcp, COUNTING);
      ada = yield* viewer.open(runner.page({ name: "Ada", fit: "0" }));
      bob = yield* viewer.open(runner.page({ name: "Bob", fit: "0" }));
      yield* ready(ada, 2);
      yield* ready(bob, 2);
      adaId = yield* snapshot(ada, "s.presence.you", Schema.Number);
      bobId = yield* snapshot(bob, "s.presence.you", Schema.Number);
      for (const page of [ada, bob]) {
        yield* page.evaluate(`apertureSession.select(${shared})`);
        yield* page.until(`apertureSession.getSnapshot().selected === ${shared}`);
        yield* page.until("document.querySelector('[data-aperture-surface=video]').videoWidth > 0");
      }

      picture = yield* ada.box("[data-aperture-surface=video]");
      yield* pointAt(ada, picture, -60, -20);
      expect(yield* appears(bob, pointerOf(adaId), "5 seconds")).toBe(true);
      expect(yield* bob.text(pointerOf(adaId))).toContain("Ada");
      expect(yield* has(ada, pointerOf(adaId))).toBe(false);
    }),
  );

  it.effect("a stroke one draws is seen by both, and is no input to the page", () =>
    Effect.gen(function* () {
      expect(yield* has(ada, "[data-workbench-draw]")).toBe(true);
      yield* ada.click("[data-workbench-draw]");
      yield* ada.until(
        "document.querySelector('[data-member-marks]')?.dataset.memberMarks === 'drawing'",
      );
      // What the pointer did before is input that may still be on its way to the page.
      yield* Effect.sleep("500 millis");
      pointedBefore = yield* pointed();

      yield* drawStroke(ada, picture);
      expect(yield* happens(inked(ada).pipe(Effect.map((drawn) => drawn > 200)), "3 seconds")).toBe(
        true,
      );
      expect(yield* happens(inked(bob).pipe(Effect.map((drawn) => drawn > 200)), "3 seconds")).toBe(
        true,
      );
      expect(yield* pointed()).toBe(pointedBefore);
    }),
  );

  it.effect("whoever draws still shows where they point, which is no input either", () =>
    Effect.gen(function* () {
      const before = yield* whereBobSeesAda();
      yield* pointAt(ada, picture, 140, 110);
      const moved = yield* happens(
        whereBobSeesAda().pipe(Effect.map((where) => where !== "" && where !== before)),
        "3 seconds",
      );
      expect(moved).toBe(true);
      expect(yield* pointed()).toBe(pointedBefore);
    }),
  );

  it.effect("a stroke fades once it has ended, and the pointer is shown as before", () =>
    Effect.gen(function* () {
      yield* ada.click("[data-workbench-draw]");
      expect(
        yield* happens(inked(bob).pipe(Effect.map((drawn) => drawn === 0)), "15 seconds"),
      ).toBe(true);
      yield* pointAt(ada, picture, -60, -20);
      expect(yield* appears(bob, pointerOf(adaId), "3 seconds")).toBe(true);
    }),
  );

  it.effect("the others' pointers are hidden when asked, which this browser remembers", () =>
    Effect.gen(function* () {
      yield* openMenu(bob, "[data-workbench-picture]", POINTERS);
      expect(yield* hasItem(bob, POINTERS)).toBe(true);
      yield* closeMenus(bob);

      yield* togglePointers(bob);
      yield* pointAt(ada, picture, -30, -10);
      expect(yield* leaves(bob, pointerOf(adaId), "3 seconds")).toBe(true);
      const remembered = yield* bob.evaluate("localStorage.getItem('aperture.session.pointers')");
      expect(remembered).toBe("false");

      yield* togglePointers(bob);
      yield* pointAt(ada, picture, -40, -15);
      expect(yield* appears(bob, pointerOf(adaId), "3 seconds")).toBe(true);
    }),
  );

  it.effect("whoever follows goes to the tab the followed watches, and along with them", () =>
    Effect.gen(function* () {
      yield* ada.evaluate("apertureSession.newTab()");
      yield* ada.until(`apertureSession.getSnapshot().selected !== ${shared}`);
      other = yield* snapshot(ada, "s.selected", Schema.Number);
      yield* Effect.sleep("500 millis");
      expect(yield* snapshot(bob, "s.selected")).toBe(shared);

      yield* bob.click(`[data-member-follow="${adaId}"]`);
      expect(yield* comes(bob, `s.selected === ${other}`, "5 seconds")).toBe(true);
      expect(yield* comes(ada, `${followedBy(bobId)} === ${adaId}`, "5 seconds")).toBe(true);

      yield* ada.evaluate(`apertureSession.select(${shared})`);
      expect(yield* comes(bob, `s.selected === ${shared}`, "5 seconds")).toBe(true);
    }),
  );

  it.effect("nobody is followed around a circle", () =>
    Effect.gen(function* () {
      yield* ada.evaluate(
        "(window.failures = [], apertureSession.onFailure((failure) => window.failures.push(failure)), true)",
      );
      yield* ada.evaluate(`apertureSession.follow(${bobId})`);
      const refused = yield* happens(
        ada.evaluate("JSON.stringify(window.failures).includes('circle')"),
        "5 seconds",
      );
      expect(refused, yield* ada.evaluate("JSON.stringify(window.failures)", Schema.String)).toBe(
        true,
      );
    }),
  );

  it.effect("whoever selects a tab itself follows nobody", () =>
    Effect.gen(function* () {
      yield* bob.evaluate(`apertureSession.select(${other})`);
      expect(yield* comes(ada, `${followedBy(bobId)} === undefined`, "5 seconds")).toBe(true);
      yield* ada.evaluate(`apertureSession.closeTab(${other})`);
      expect(yield* comes(bob, `!s.targets.some((target) => target.tab === ${other})`)).toBe(true);
    }),
  );

  it.effect("the pages threw nothing", () =>
    Effect.sync(() => {
      expect(ada.errors()).toEqual([]);
      expect(bob.errors()).toEqual([]);
    }),
  );
});
