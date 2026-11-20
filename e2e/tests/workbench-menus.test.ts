import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Mcp from "../src/mcp.ts";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import { type Page, ready, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens } from "../src/wait.ts";
import {
  appears,
  clickItem,
  clickPicture,
  closeMenus,
  closeTab,
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

const LINKED = "https://example.com/?from=link";

const LINKING = dataPage(`
  <title>Menus check</title>
  <body style="margin:0">
    <a href="${LINKED}" style="position:absolute;left:100px;top:200px;font-size:30px">a link to follow</a>
    <p id="words" style="position:absolute;left:100px;top:260px;font-size:30px;margin:0">some text</p>
  </body>
`);

/** A point on the page's link, in the tab's logical pixels. */
const LINK = { x: 180, y: 215 };

const PAGE_MENU = "[data-session-page-menu]";

/** The page menu's edges, and the window's. */
const menuWithinWindow = (page: Page) =>
  page.evaluate(
    `(() => {
      const menu = document.querySelector("${PAGE_MENU}").getBoundingClientRect();
      return menu.left >= 0 && menu.top >= 0 && menu.right <= innerWidth && menu.bottom <= innerHeight;
    })()`,
  );

/** Has this browser refuse what a page writes to its clipboard without a click. */
const refuseClipboard = (page: Page) =>
  page.evaluate(
    `(() => {
      const refuse = () => Promise.reject(new DOMException("refused", "NotAllowedError"));
      navigator.clipboard.write = refuse;
      navigator.clipboard.writeText = refuse;
    })()`,
  );

suite(session)("the workbench's menus and the clipboard", (it) => {
  let page: Page;
  let mcp: Mcp.Mcp;
  let linking: number;

  it.effect("a right click on a link shows the page menu where the click was", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      mcp = yield* Mcp.connect(runner.url, runner.token);
      page = yield* viewer.open(runner.page(), { scheme: "light" });
      yield* ready(page);
      yield* keepErrors(page);
      linking = yield* openByAutomation(mcp, LINKING);
      yield* page.until(`!!document.querySelector('[data-browser-tab][data-tab="${linking}"]')`);
      expect(yield* selectTab(page, linking)).toBe(true);
      yield* page.until("document.querySelector('[data-aperture-surface=video]').videoWidth > 0");

      const clicked = yield* clickPicture(page, LINK.x, LINK.y, "right");
      expect(yield* comes(page, "s.menu !== undefined && s.menu.link !== undefined")).toBe(true);
      expect(yield* appears(page, PAGE_MENU)).toBe(true);
      yield* Effect.sleep("300 millis");
      const menu = yield* page.box(PAGE_MENU);
      expect(Math.abs(menu.left - clicked.x)).toBeLessThan(6);
      expect(Math.abs(menu.top - clicked.y)).toBeLessThan(6);
    }),
  );

  it.effect("'Open link in new tab' opens the link in a tab, and the menu goes", () =>
    Effect.gen(function* () {
      const before = yield* snapshot(page, "s.targets.length", Schema.Number);
      yield* clickItem(page, "Open link in new tab");
      const opened = yield* comes(
        page,
        `s.targets.length === ${before + 1} && s.targets.some((target) => target.url.startsWith("${LINKED}"))`,
        "20 seconds",
      );
      expect(opened).toBe(true);
      expect(yield* comes(page, "s.menu === undefined")).toBe(true);

      const followed = yield* snapshot(
        page,
        `s.targets.find((target) => target.url.startsWith("${LINKED}")).tab`,
        Schema.Number,
      );
      expect(yield* closeTab(page, followed)).toBe(true);
    }),
  );

  it.effect("the page menu stays within the window near its edge, and Escape dismisses it", () =>
    Effect.gen(function* () {
      expect(yield* selectTab(page, linking)).toBe(true);
      yield* Effect.sleep("500 millis");
      const corner = yield* snapshot(
        page,
        "({ x: watched.width - 10, y: watched.height - 5 })",
        Schema.Struct({ x: Schema.Number, y: Schema.Number }),
      );
      yield* clickPicture(page, corner.x, corner.y, "right");
      expect(yield* appears(page, PAGE_MENU)).toBe(true);
      yield* Effect.sleep("300 millis");
      expect(yield* menuWithinWindow(page)).toBe(true);

      yield* escape(page);
      expect(yield* comes(page, "s.menu === undefined")).toBe(true);
    }),
  );

  it.effect("'Copy link address' copies the link to this browser's clipboard", () =>
    Effect.gen(function* () {
      yield* clickPicture(page, LINK.x, LINK.y, "right");
      yield* clickItem(page, "Copy link address");
      const copied = yield* happens(
        page.evaluate("navigator.clipboard.readText()").pipe(Effect.map((text) => text === LINKED)),
      );
      expect(copied).toBe(true);
    }),
  );

  it.effect("the browser menu offers to copy from the session", () =>
    Effect.gen(function* () {
      yield* openMenu(page, "[data-workbench-menu]", "Copy from the session");
      expect(yield* page.evaluate(`!!(${menuItem("Copy from the session")})`)).toBe(true);
      yield* closeMenus(page);
    }),
  );

  it.effect("a copy this browser's clipboard refuses is offered as a notice", () =>
    Effect.gen(function* () {
      yield* refuseClipboard(page);
      yield* inTab(
        mcp,
        linking,
        "(getSelection().selectAllChildren(document.getElementById('words')), true)",
      );
      yield* page.evaluate("apertureSession.copySelection()");
      const noticed = yield* happens(
        page
          .text("[data-sonner-toast]")
          .pipe(Effect.map((text) => text?.includes("The session copied something") === true)),
      );
      expect(noticed).toBe(true);
    }),
  );

  it.effect("the page threw nothing and logged no error", () =>
    Effect.gen(function* () {
      expect(page.errors()).toEqual([]);
      expect(yield* loggedErrors(page)).toEqual([]);
    }),
  );
});
