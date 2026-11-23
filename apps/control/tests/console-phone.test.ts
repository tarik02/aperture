import * as Mcp from "@aperture-browser/e2e/src/mcp.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Proxy from "./src/proxy.ts";
import {
  LONG,
  ALL_ON_SCREEN,
  BUTTONS,
  closed,
  needs,
  onScreen,
  placed,
  shot,
  signInWithToken,
  snug,
  withSession,
} from "./src/console.ts";

suite(needs)("the console and a session on a phone, behind the proxy", (it) => {
  it.effect(
    "on a phone the menu closes when it leads elsewhere, a table and a dialog fit, and a finger scrolls the session",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const { account: ada, path } = yield* withSession("Ada");
        // Signed in from a desk first: every page of the browser is then.
        const desk = yield* viewer.open(`${proxy.url}/`);
        yield* signInWithToken(desk, ada.token);
        yield* desk.until(`!!document.querySelector("[data-console-session]")`);
        yield* desk.close;
        const id = path.split("/").at(-1) ?? "";
        const page = yield* viewer.open(`${proxy.url}/-/account/tokens`, {
          width: 390,
          height: 844,
          mobile: true,
        });
        // A table's rows are blocks of their own there: nothing of it is off to the side.
        yield* page.until(`!!document.querySelector("[data-console-token]")`);
        yield* shot(page, fs, "console-phone-tokens");
        expect(
          yield* page.evaluate(
            `(() => {
              const table = document.querySelector('[data-slot="table-container"] [data-slot="scroll-area-viewport"]');
              const rows = [...document.querySelectorAll("[data-console-token] td")];
              return {
                page: document.documentElement.scrollWidth <= innerWidth,
                table: table.scrollWidth <= table.clientWidth,
                cells: rows.every((cell) => cell.getBoundingClientRect().right <= innerWidth),
              };
            })()`,
          ),
        ).toEqual({ page: true, table: true, cells: true });

        // The menu is a drawer, which is gone once what was pressed in it led elsewhere.
        const drawer = `[data-mobile="true"][data-open]`;
        yield* page.click(`[data-slot="sidebar-trigger"]`);
        yield* page.until(`!!document.querySelector('${drawer}')`);
        yield* page.until(
          `document.querySelector('${drawer}').getAnimations().every((one) => one.playState === "finished")`,
        );
        yield* shot(page, fs, "console-phone-drawer");
        yield* page.click(`${drawer} a[href="/-/sessions"]`);
        yield* page.until(
          `location.pathname === "/-/sessions" && !document.querySelector('${drawer}')`,
        );

        // A dialog is a sheet at the foot of the screen, with all of its buttons on it.
        yield* page.until(`!!document.querySelector("[data-console-create-custom]")`);
        yield* page.click("[data-console-create-custom]");
        yield* page.until(`!!document.querySelector('${BUTTONS} button')`);
        yield* placed(page);
        yield* shot(page, fs, "console-phone-dialog");
        expect(
          yield* page.evaluate(
            `[...document.querySelectorAll('${BUTTONS} button')].every((button) => {
              const box = button.getBoundingClientRect();
              return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
            })`,
          ),
        ).toBe(true);
        yield* closed(page);

        // With the keyboard up the window is short. A dialog of tabs, whose body has a set
        // height, is then no taller than what is left: its title and its buttons stay, and
        // what is typed into is seen between them. So is one that is as tall as what it
        // holds, which is all seen where there is room for it.
        for (const height of [480, 360]) {
          const short = yield* viewer.open(`${proxy.url}/-/sessions`, {
            width: 390,
            height,
            mobile: true,
          });
          yield* short.until(`!!document.querySelector("[data-console-create-custom]")`);
          yield* short.click("[data-console-create-custom]");
          yield* short.until(
            `document.activeElement === document.querySelector("[data-console-session-create] input")`,
          );
          yield* placed(short);
          expect(yield* onScreen(short)).toEqual(ALL_ON_SCREEN);
          yield* closed(short);

          yield* short.evaluate(`void (location.href = "/-/workspaces")`);
          yield* short.until(`!!document.querySelector("[data-console-workspace-new]")`);
          yield* short.click("[data-console-workspace-new]");
          yield* short.until(
            `document.activeElement === document.querySelector("[data-console-name-dialog] input")`,
          );
          yield* placed(short);
          expect(yield* onScreen(short)).toEqual(ALL_ON_SCREEN);
          expect(yield* snug(short)).toEqual({ scrolls: false, room: 0 });
          expect(short.errors()).toEqual([]);
          yield* short.close;
        }

        // A finger that moves over the session's picture scrolls its page: it is no mouse
        // with its button held, which would select what it passes over.
        yield* page.evaluate(`void (location.href = ${JSON.stringify(`/-/sessions/${id}`)})`);
        yield* Viewer.ready(page);
        const tall = `data:text/html,<title>tall</title><body style="margin:0;height:6000px"><script>let pressed = false; addEventListener("mousedown", () => { pressed = true; }); addEventListener("scroll", () => { document.title = pressed ? "pressed" : "scrolled"; });</script>`;
        const title = `apertureSession.getSnapshot().targets.find((target) => target.tab === apertureSession.getSnapshot().selected)?.title`;
        // The page is put there by automation, which opens what is no page on the web, and
        // is watched once it is there.
        const agent = yield* Mcp.connect(`${proxy.url}${path}`, ada.token);
        yield* agent.call("navigate", { url: tall });
        const opened = `apertureSession.getSnapshot().targets.find((target) => target.title === "tall")`;
        yield* page.until(`!!${opened}`, "30 seconds");
        yield* page.evaluate(`void apertureSession.select(${opened}.tab)`);
        yield* page.until(`${title} === "tall"`, "30 seconds");
        yield* page.until(`!!document.querySelector("[data-aperture-drawn]")`, "30 seconds");
        // A tab is made as large as the window of whoever watches it from a phone, and its
        // picture is another's until then: the finger is put on it once it is that large
        // and at rest, as it is by the time anyone has seen it.
        // It is sized more than once as the window's bar comes over it, and what turns
        // under a finger while it is sized turns nothing: it has the size of what shows it,
        // and had it when last looked at.
        const fitted = `(() => {
          const stage = document.querySelector("[data-aperture-stage]").getBoundingClientRect();
          const tab = ${opened};
          return tab.width === Math.round(stage.width) && tab.height === Math.round(stage.height) ? tab.width + "x" + tab.height : null;
        })()`;
        let fittedBefore: string | null = null;
        yield* until(
          "the tab keeping the size of what shows it",
          Effect.map(page.evaluate(fitted, Schema.NullOr(Schema.String)), (now) => {
            const kept = now !== null && now === fittedBefore;
            fittedBefore = now;
            return kept;
          }),
          "20 seconds",
        );
        const stage = yield* page.rests(`document.querySelector("[data-aperture-stage]")`);
        // Lifted as it moves: the page goes on under where the finger was.
        yield* page.finger(
          Viewer.along({ x: stage.x, y: stage.y + 200 }, { x: stage.x, y: stage.y - 100 }, 15),
        );
        yield* page.until(`${title} !== "tall"`);
        expect(yield* page.evaluate(title, Schema.String)).toBe("scrolled");
        yield* shot(page, fs, "console-phone-workbench");

        // A phone's workbench is the picture with one bar over its foot, in place of a
        // browser's rows above it. The finger that moved the page down put the bar away:
        // a small mark stands for it, and the picture has all the room there is.
        const phone = "[data-workbench-phone]";
        const bar = "[data-workbench-phone-bar]";
        const mark = "[data-workbench-phone-mark]";
        const barAt = `document.querySelector(${JSON.stringify(phone)}).dataset.bar`;
        /**
         * A sheet that has come in: it does a moment after what it shows is there. What it
         * shows may move for as long as it is there, as what pulses does.
         */
        const landed = (selector: string) =>
          page.until(
            `(() => {
              const sheet = document.querySelector(${JSON.stringify(selector)});
              return sheet !== null && sheet.hasAttribute("data-open") && !sheet.hasAttribute("data-starting-style") && sheet.getAnimations().every((one) => one.playState === "finished");
            })()`,
          );
        const still = (selector: string) =>
          page.until(
            `document.querySelector(${JSON.stringify(selector)}).getAnimations({ subtree: true }).every((one) => one.playState === "finished")`,
          );
        /** How long a finger rests before it is lifted, which flings nothing on. */
        const RESTS = "150 millis";
        /** A finger put down, moved from one place to another, and lifted after a rest. */
        const drawn = (x: number, from: number, to: number) =>
          page.finger(Viewer.along({ x, y: from }, { x, y: to }), RESTS);
        /** A finger moved along the window's width, as `drawn` moves one along its height. */
        const drawnAcross = (from: number, to: number, y: number) =>
          page.finger(Viewer.along({ x: from, y }, { x: to, y }), RESTS);
        const tapAt = page.tapAt;
        // The finger that scrolled holds the tab, from a phone: its pages are a phone's.
        const watched = `apertureSession.getSnapshot().targets.find((target) => target.tab === apertureSession.getSnapshot().selected)`;
        yield* page.until(`${watched}.mobile && ${watched}.width === innerWidth`, "20 seconds");
        yield* page.until(`${barAt} === "away"`);
        const sized = `${watched}.width + "x" + ${watched}.height`;
        const size = yield* page.evaluate(sized, Schema.String);
        expect(
          yield* page.evaluate(
            `(() => {
              const box = (selector) => document.querySelector(selector).getBoundingClientRect();
              const all = box(${JSON.stringify(phone)});
              const stage = box("[data-aperture-stage]");
              return {
                rows: document.querySelectorAll("[data-workbench-titlebar], [data-workbench-toolbar]").length,
                fills: stage.top === all.top && stage.bottom === all.bottom && stage.width === all.width,
                page: ${watched}.height === Math.round(stage.height),
                bar: document.querySelector(${JSON.stringify(bar)}).inert,
              };
            })()`,
          ),
        ).toEqual({ rows: 0, fills: true, page: true, bar: true });
        yield* still(phone);
        yield* shot(page, fs, "console-phone-workbench-bar-away");

        // Pressing the mark brings the bar back, over the picture and within the screen,
        // with the way back alone before the address, and what is pressed in it large
        // enough for a finger. The page that was flung is at rest by then.
        yield* Effect.sleep("1500 millis");
        yield* page.click(mark);
        yield* page.until(`${barAt} === "shown"`);
        yield* still(phone);
        yield* shot(page, fs, "console-phone-workbench-bar");
        const laid = `(() => {
          const box = (selector) => document.querySelector(selector).getBoundingClientRect();
          const pill = box("[data-workbench-phone-pill]");
          const stage = box("[data-aperture-stage]");
          // Without who else is in the session, which is there when someone is.
          const pressed = [...document.querySelectorAll(${JSON.stringify(`${bar} button:not([data-session-presence])`)})];
          return {
            over: pill.top >= stage.top && pill.bottom <= stage.bottom,
            within: pill.left >= 0 && pill.right <= innerWidth && pill.bottom <= innerHeight,
            pressed: pressed.map((one) => one.getAttribute("aria-label").replace(/\\d+/u, "n")),
            large: pressed.every((one) => {
              const size = one.getBoundingClientRect();
              return size.width >= 40 && size.height >= 40;
            }),
          };
        })()`;
        expect(yield* page.evaluate(laid)).toEqual({
          over: true,
          within: true,
          pressed: ["Back", "Address", "Tabs: n", "Menu"],
          large: true,
        });

        // Moving the page down puts the bar away and moving it up brings it back, and the
        // page has the size it had through all of it: nothing of it is drawn anew.
        yield* drawn(stage.x, stage.y + 100, stage.y - 20);
        yield* page.until(`${barAt} === "away"`);
        yield* drawn(stage.x, stage.y - 20, stage.y + 40);
        yield* page.until(`${barAt} === "shown"`);
        yield* Effect.sleep("500 millis");
        expect(yield* page.evaluate(sized, Schema.String)).toBe(size);

        // Swiped down, the bar is away as well; and the mark, swiped down, is gone too,
        // for a page that has something of its own under it, until the page is moved up.
        const pill = yield* page.box("[data-workbench-phone-pill]");
        yield* drawn(pill.x, pill.y, pill.y + 40);
        yield* page.until(`${barAt} === "away"`);
        yield* still(phone);
        const small = yield* page.box(mark);
        yield* drawn(small.x, small.y - 4, small.y + 8);
        yield* page.until(`${barAt} === "gone"`);
        expect(
          yield* page.evaluate(
            `document.querySelector(${JSON.stringify(mark)}).closest("[inert]") !== null`,
          ),
        ).toBe(true);
        yield* drawn(stage.x, stage.y - 20, stage.y + 40);
        yield* page.until(`${barAt} === "shown"`);
        yield* still(phone);

        // The address is typed across the bar, which stays while it is, whatever a finger
        // does with the page meanwhile; and it is left with what it was.
        yield* page.click("[data-workbench-address-button]");
        yield* page.until(
          `document.activeElement === document.querySelector("[data-workbench-address]")`,
        );
        expect(yield* page.evaluate(`document.activeElement.value === ${watched}.url`)).toBe(true);
        yield* drawn(stage.x, stage.y + 100, stage.y - 100);
        expect(
          yield* page.evaluate(
            `${barAt} === "shown" && document.activeElement === document.querySelector("[data-workbench-address]")`,
          ),
        ).toBe(true);
        yield* shot(page, fs, "console-phone-workbench-address");
        yield* page.key("Escape", "Escape", 27);
        yield* page.until(`!!document.querySelector("[data-workbench-address-button]")`);
        expect(yield* page.evaluate(sized, Schema.String)).toBe(size);

        // The tabs are a sheet of cards with a picture each, half of the way up the
        // window at first.
        const switcher = "[data-workbench-tab-switcher]";
        const tabs = `apertureSession.getSnapshot().targets`;
        const height = `document.querySelector('${switcher}')?.dataset.height`;
        const top = `document.querySelector('${switcher}').getBoundingClientRect().top`;
        yield* page.click("[data-workbench-tabs]");
        yield* page.until(
          `document.querySelectorAll('${switcher} [data-tab-card]').length === ${tabs}.length && ${tabs}.length > 1`,
        );
        yield* page.until(
          `document.querySelectorAll('${switcher} [data-tab-card-picture]').length === ${tabs}.length`,
          "20 seconds",
        );
        yield* landed(switcher);
        yield* shot(page, fs, "console-phone-workbench-tabs");
        expect(
          yield* page.evaluate(
            `(() => {
              const cards = [...document.querySelectorAll('${switcher} [data-tab-card]')];
              return {
                height: ${height},
                part: ${top} > innerHeight * 0.45 && ${top} < innerHeight * 0.55,
                watched: cards.filter((card) => card.hasAttribute("data-active")).map((card) => Number(card.dataset.tabCard)),
                closes: cards.every((card) => {
                  const size = card.querySelector("[data-tab-card-close]").getBoundingClientRect();
                  return size.width >= 40 && size.height >= 40;
                }),
                page: document.documentElement.scrollWidth <= innerWidth,
                bar: ${barAt},
              };
            })()`,
          ),
        ).toEqual({
          height: "part",
          part: true,
          watched: [yield* page.evaluate(`apertureSession.getSnapshot().selected`, Schema.Number)],
          closes: true,
          page: true,
          bar: "shown",
        });
        // Dragged up by its head it is whole, and dragged down it is gone.
        const head = yield* page.evaluate(top, Schema.Number);
        yield* drawn(stage.x, head + 30, 80);
        yield* page.until(`${height} === "full" && ${top} < innerHeight * 0.1`);
        yield* landed(switcher);
        yield* shot(page, fs, "console-phone-workbench-tabs-full");
        yield* drawn(stage.x, (yield* page.evaluate(top, Schema.Number)) + 30, stage.y * 2 - 20);
        yield* page.until(`!document.querySelector('${switcher}')`);
        // A swipe up the bar opens it, and a press beside it is rid of it.
        const swiped = yield* page.box("[data-workbench-phone-pill]");
        yield* drawn(swiped.x, swiped.y, swiped.y - 60);
        yield* page.until(`${height} === "part"`);
        yield* landed(switcher);
        yield* tapAt(stage.x, 40);
        yield* page.until(`!document.querySelector('${switcher}')`);
        // And so is pressing a card, which goes to its tab.
        yield* page.click("[data-workbench-tabs]");
        yield* page.until(`${height} === "part"`);
        yield* landed(switcher);
        const other = yield* page.evaluate(
          `${tabs}.find((target) => target.tab !== apertureSession.getSnapshot().selected).tab`,
          Schema.Number,
        );
        yield* page.click(`${switcher} [data-tab-card="${other}"] button[aria-label^="Switch to"]`);
        yield* page.until(
          `apertureSession.getSnapshot().selected === ${other} && !document.querySelector('${switcher}')`,
        );

        // The menu is a sheet, half of the way up the window at first: the rest by kind,
        // with what is done with the session and the way to the sidebar, and below that,
        // nearest the thumb, what is done most as a row of buttons, the way forward among
        // them.
        const menu = "[data-workbench-phone-menu]";
        const sheet = `document.querySelector("[data-menu-sheet]").getBoundingClientRect()`;
        const sheetHeight = `document.querySelector("[data-menu-sheet]")?.dataset.height`;
        const settled = landed("[data-menu-sheet]");
        const pageOf = (title: string) => `[data-menu-sheet-page="${title}"]`;
        /**
         * Presses what is in the menu by a finger, once it is at rest where it is pressed:
         * a page of the menu slides in with all it holds, and a finger put where its way
         * back was a moment ago is put beside the menu. A mouse left over the menu is over
         * another row once the rows move, as when a page of it comes or goes or the phone
         * is turned, and a menu takes that for leaving the page that is open.
         */
        const tap = page.tap;
        /** Presses a row of the menu, which may be below what the sheet shows of it at rest. */
        const pressRow = (row: string) =>
          Effect.gen(function* () {
            yield* page.evaluate(
              `document.querySelector('${menu} ${row}').scrollIntoView({ block: "center" })`,
            );
            yield* tap(`${menu} ${row}`);
          });
        /** Opens the page a row of the menu leads to. */
        const openPage = (row: string, title: string, within?: string) =>
          Effect.gen(function* () {
            yield* within === undefined ? pressRow(row) : tap(`${within} ${row}`);
            yield* page.until(`!!document.querySelector('${pageOf(title)}')`);
          });
        /** Leaves a page of the menu by its way back. */
        const leavePage = (title: string) =>
          Effect.gen(function* () {
            yield* tap(`${pageOf(title)} [data-menu-sheet-back]`);
            yield* page.until(`!document.querySelector('${pageOf(title)}')`);
          });
        yield* page.click("[data-workbench-menu]");
        yield* page.until(`!!document.querySelector('${menu} [data-workbench-page-mode]')`);
        yield* settled;
        yield* shot(page, fs, "console-phone-workbench-menu");
        expect(
          yield* page.evaluate(
            `["[data-phone-menu-forward]", "[data-phone-menu-reload]", "[data-phone-menu-copy-url]", "[data-phone-menu-new-tab]", "[data-workbench-keyboard]", "[data-phone-menu-page=clipboard]", "[data-workbench-page-mode]", "[data-session-files-button]", "[data-phone-menu-page=recording]", "[data-console-session-submenu]", "[data-phone-menu-page=view]", "[data-console-sidebar-trigger]"].filter((item) => document.querySelector('${menu} ' + item) === null)`,
          ),
        ).toEqual([]);
        expect(
          yield* page.evaluate(
            `(() => {
              const forward = document.querySelector('${menu} [data-phone-menu-forward]');
              const sheet = ${sheet};
              return {
                forward: forward.hasAttribute("data-disabled") === !${watched}.goesForward,
                foot: sheet.left === 0 && sheet.width === innerWidth,
                height: ${sheetHeight},
                part: sheet.top > innerHeight * 0.45 && sheet.top < innerHeight * 0.55,
                quick: Math.round(forward.getBoundingClientRect().bottom) <= innerHeight && forward.getBoundingClientRect().bottom > innerHeight - 80,
                rows: [...document.querySelectorAll('${menu} [role^=menuitem]')].every((row) => row.getBoundingClientRect().height >= 40),
              };
            })()`,
          ),
        ).toEqual({
          forward: true,
          foot: true,
          height: "part",
          part: true,
          quick: true,
          rows: true,
        });
        // It follows the finger: dragged up by its head it is whole, and dragged down
        // from there it is half of the way up again.
        const grip = "[data-slot=dropdown-menu-sheet-grip]";
        const low = yield* page.box(grip);
        yield* drawn(low.x, low.y, 150);
        yield* page.until(`${sheetHeight} === "full" && ${sheet}.top < innerHeight * 0.3`);
        yield* settled;
        yield* shot(page, fs, "console-phone-workbench-menu-full");
        const whole = yield* page.box(grip);
        yield* drawn(whole.x, whole.y, whole.y + 200);
        yield* page.until(`${sheetHeight} === "part" && ${sheet}.top > innerHeight * 0.45`);
        yield* settled;
        // What has more to it is a page of the sheet, which slides in over it with the
        // way back, and a page of a page is one as well: the sheet keeps its height.
        const kept = yield* page.evaluate(
          `document.querySelector('${menu}').getBoundingClientRect().height`,
          Schema.Number,
        );
        yield* openPage("[data-phone-menu-page=view]", "View");
        yield* still(pageOf("View"));
        yield* shot(page, fs, "console-phone-workbench-menu-view");
        expect(
          yield* page.evaluate(
            `document.querySelector('${pageOf("View")}').getBoundingClientRect().height`,
          ),
        ).toBe(kept);
        yield* openPage("[data-phone-menu-page=picture]", "Picture and viewport", pageOf("View"));
        yield* still(pageOf("Picture and viewport"));
        expect(
          yield* page.evaluate(
            `document.querySelector('${pageOf("Picture and viewport")}').getBoundingClientRect().height`,
          ),
        ).toBe(kept);
        yield* leavePage("Picture and viewport");
        yield* leavePage("View");
        yield* openPage("[data-console-session-submenu]", "Session");
        yield* still(pageOf("Session"));
        yield* shot(page, fs, "console-phone-workbench-menu-session");
        // A press beside the sheet is rid of it, whichever page it shows.
        yield* tapAt(stage.x, 20);
        yield* page.until(`!document.querySelector('${menu}')`);
        yield* still(phone);
        // The bar is the one there is: nothing chooses another.
        expect(
          yield* page.evaluate(
            `document.querySelector("[data-workbench-phone-pill]").getBoundingClientRect().width > innerWidth * 0.9`,
          ),
        ).toBe(true);

        // Dragged down by its top the menu is gone.
        yield* page.click("[data-workbench-menu]");
        yield* page.until(`!!document.querySelector('${menu} [data-workbench-page-mode]')`);
        yield* settled;
        const gripped = yield* page.box(grip);
        yield* drawn(gripped.x, gripped.y, gripped.y + 320);
        yield* page.until(`!document.querySelector('${menu}')`);

        // The files are a sheet as the others are: half of the way up, dragged up to be
        // whole and down to be gone.
        const files = "[data-session-files]";
        const filesTop = `document.querySelector('${files}').getBoundingClientRect().top`;
        yield* page.click("[data-workbench-menu]");
        yield* page.until(`!!document.querySelector('${menu} [data-session-files-button]')`);
        yield* settled;
        yield* pressRow("[data-session-files-button]");
        yield* page.until(
          `document.querySelector('${files}')?.dataset.height === "part" && !document.querySelector('${menu}')`,
        );
        yield* landed(files);
        yield* shot(page, fs, "console-phone-workbench-files");
        yield* drawn(stage.x, (yield* page.evaluate(filesTop, Schema.Number)) + 8, 80);
        yield* page.until(`document.querySelector('${files}')?.dataset.height === "full"`);
        yield* landed(files);
        yield* drawn(
          stage.x,
          (yield* page.evaluate(filesTop, Schema.Number)) + 8,
          stage.y * 2 - 20,
        );
        yield* page.until(`!document.querySelector('${files}')`);

        // Held on its side the phone has a rail along the picture's side in place of
        // the bar across its foot, and what opens from it comes in from that side. The
        // menu that was open when the phone was turned is the one there is, on the page
        // it showed.
        const lay = `document.querySelector(${JSON.stringify(phone)}).dataset.lay`;
        const turn = (width: number, height: number) =>
          page.cdp.call("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: true,
            screenOrientation: Viewer.held(width, height),
          });
        expect(yield* page.evaluate(lay, Schema.String)).toBe("foot");
        yield* page.click("[data-workbench-menu]");
        yield* page.until(`!!document.querySelector('${menu} [data-phone-menu-page=view]')`);
        yield* settled;
        yield* openPage("[data-phone-menu-page=view]", "View");
        yield* still(pageOf("View"));
        yield* turn(844, 390);
        yield* page.until(`${lay} === "right" && ${sheet}.height === innerHeight`);
        yield* settled;
        yield* shot(page, fs, "console-phone-workbench-side-menu");
        expect(
          yield* page.evaluate(
            `(() => {
              const sheet = ${sheet};
              return {
                sheets: document.querySelectorAll("[data-menu-sheet]").length,
                page: !!document.querySelector('${pageOf("View")}'),
                side: Math.round(sheet.right) === innerWidth && sheet.top === 0 && sheet.width < innerWidth * 0.6,
              };
            })()`,
          ),
        ).toEqual({ sheets: 1, page: true, side: true });
        yield* leavePage("View");
        // Dragged to its side the menu is gone.
        const side = yield* page.box("[data-menu-sheet]");
        yield* drawnAcross(side.left + 40, side.left + 330, 12);
        yield* page.until(`!document.querySelector('${menu}')`);
        yield* page.until(`document.querySelectorAll("[data-slot=drawer-overlay]").length === 0`);

        // The rail is over the picture, which has the whole of the window: the page is
        // as wide as that, and is no narrower for the rail.
        yield* page.until(
          `${watched}.width === innerWidth && ${watched}.height === Math.round(document.querySelector("[data-aperture-stage]").getBoundingClientRect().height)`,
          "20 seconds",
        );
        yield* still(phone);
        yield* shot(page, fs, "console-phone-workbench-rail");
        const wide = yield* page.evaluate(sized, Schema.String);
        expect(
          yield* page.evaluate(
            `(() => {
              const box = (selector) => document.querySelector(selector).getBoundingClientRect();
              const pill = box("[data-workbench-phone-pill]");
              const all = box(${JSON.stringify(phone)});
              const stage = box("[data-aperture-stage]");
              const pressed = [...document.querySelectorAll(${JSON.stringify(`${bar} button:not([data-session-presence])`)})];
              return {
                rail: document.querySelector(${JSON.stringify(bar)}).dataset.rail,
                slim: pill.width <= 56 && pill.height > pill.width,
                edge: pill.right <= innerWidth && pill.right > innerWidth - 16 && pill.top >= 0 && pill.bottom <= innerHeight,
                fills: stage.width === all.width && stage.height === all.height,
                pressed: pressed.map((one) => one.getAttribute("aria-label").replace(/\\d+/u, "n")),
                large: pressed.every((one) => {
                  const size = one.getBoundingClientRect();
                  return size.width >= 40 && size.height >= 40;
                }),
              };
            })()`,
          ),
        ).toEqual({
          rail: "right",
          slim: true,
          edge: true,
          fills: true,
          pressed: ["Back", "Address", "Tabs: n", "Menu"],
          large: true,
        });
        // It goes as the page is moved down, with a mark at its side, and is back as the
        // page is moved up; the page keeps its size.
        const middle = { x: 300, y: 195 };
        yield* drawn(middle.x, middle.y + 100, middle.y - 60);
        yield* page.until(`${barAt} === "away"`);
        yield* still(phone);
        yield* shot(page, fs, "console-phone-workbench-rail-away");
        expect(
          yield* page.evaluate(
            `(() => {
              const mark = document.querySelector(${JSON.stringify(mark)}).getBoundingClientRect();
              return mark.right <= innerWidth && mark.left > innerWidth - 32 && document.querySelector(${JSON.stringify(bar)}).inert;
            })()`,
          ),
        ).toBe(true);
        yield* drawn(middle.x, middle.y - 60, middle.y + 20);
        yield* page.until(`${barAt} === "shown"`);
        yield* Effect.sleep("500 millis");
        expect(yield* page.evaluate(sized, Schema.String)).toBe(wide);
        yield* still(phone);

        // The address is typed across the picture's head there, the keyboard being over
        // its foot.
        yield* page.click("[data-workbench-address-button]");
        yield* page.until(
          `document.activeElement === document.querySelector("[data-workbench-address]")`,
        );
        yield* still(phone);
        expect(
          yield* page.evaluate(
            `(() => {
              const pill = document.querySelector("[data-workbench-phone-pill]").getBoundingClientRect();
              return pill.top < 16 && pill.width > innerWidth * 0.9;
            })()`,
          ),
        ).toBe(true);
        yield* shot(page, fs, "console-phone-workbench-rail-address");
        yield* page.key("Escape", "Escape", 27);
        yield* page.until(`!!document.querySelector("[data-workbench-address-button]")`);

        // The tabs come in from the rail's side, as tall as the window, and are dragged
        // to that side to be rid of them; a press beside them is rid of them as well.
        yield* page.click("[data-workbench-tabs]");
        yield* page.until(
          `document.querySelectorAll('${switcher} [data-tab-card]').length === ${tabs}.length`,
        );
        yield* landed(switcher);
        yield* shot(page, fs, "console-phone-workbench-side-tabs");
        expect(
          yield* page.evaluate(
            `(() => {
              const sheet = document.querySelector('${switcher}');
              const box = sheet.getBoundingClientRect();
              return {
                side: sheet.dataset.side,
                whole: box.top === 0 && box.height === innerHeight && Math.round(box.right) === innerWidth && box.width < innerWidth * 0.6,
                closes: [...sheet.querySelectorAll("[data-tab-card-close]")].every((one) => one.getBoundingClientRect().width >= 40),
              };
            })()`,
          ),
        ).toEqual({ side: "right", whole: true, closes: true });
        const beside = yield* page.box(switcher);
        yield* drawnAcross(beside.left + 40, beside.left + 330, 24);
        yield* page.until(`!document.querySelector('${switcher}')`);
        yield* page.click("[data-workbench-tabs]");
        yield* page.until(`!!document.querySelector('${switcher} [data-tab-card]')`);
        yield* landed(switcher);
        yield* tapAt(120, 195);
        yield* page.until(`!document.querySelector('${switcher}')`);
        // And so do the files.
        yield* page.click("[data-workbench-menu]");
        yield* page.until(`!!document.querySelector('${menu} [data-session-files-button]')`);
        yield* settled;
        yield* pressRow("[data-session-files-button]");
        yield* page.until(`document.querySelector('${files}')?.dataset.side === "right"`);
        yield* landed(files);
        yield* shot(page, fs, "console-phone-workbench-side-files");
        yield* tapAt(120, 195);
        yield* page.until(`!document.querySelector('${files}')`);

        // Held upright again it has the bar across the foot, and the page a phone's
        // shape.
        yield* turn(390, 844);
        yield* page.until(`${lay} === "foot" && ${watched}.width === innerWidth`, "20 seconds");
        yield* still(phone);
        expect(yield* page.evaluate(laid)).toEqual({
          over: true,
          within: true,
          pressed: ["Back", "Address", "Tabs: n", "Menu"],
          large: true,
        });

        yield* page.click("[data-workbench-menu]");
        yield* page.until(`!!document.querySelector('${menu} [data-console-sidebar-trigger]')`);
        yield* settled;
        yield* page.evaluate(
          `document.querySelector('${menu} [data-console-sidebar-trigger]').scrollIntoView({ block: "center" })`,
        );
        yield* page.click(`${menu} [data-console-sidebar-trigger]`);
        yield* page.until(`!!document.querySelector('${drawer}')`);
        expect(page.errors()).toEqual([]);
        yield* page.close;
      }),
    // Longer than a check gets where the machine is busy with something else.
    LONG,
  );
});
