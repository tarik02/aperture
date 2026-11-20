import { createServer, type Socket } from "node:net";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Mcp from "../src/mcp.ts";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import * as Tickets from "../src/tickets.ts";
import { type Page, ready, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens } from "../src/wait.ts";
import {
  appears,
  buttonWithin,
  clickElement,
  closeMenus,
  comes,
  dataPage,
  EVERY_FEATURE,
  has,
  hasItem,
  leaves,
  menuItem,
  openByAutomation,
  openMenu,
  pictureBox,
} from "../src/workbench.ts";

const session = Layer.mergeAll(Tickets.layer({ features: EVERY_FEATURE }), ViewerLive.layer);

/** Gives input and changes tabs, and takes no tab from whoever holds it: asks. */
const GIVES_INPUT: Tickets.Access = { input: "w", tabs: "w" };
/** Watches, and sees what was recorded. */
const WATCHES: Tickets.Access = { recordings: "r" };

const LEASE = "[data-session-lease]";
const lease = (state: string) => `[data-session-lease=${state}]`;
const CLOSED = "[data-session-closed]";
const EMPTY = "[data-session-empty]";

const SUSPENDED = "the session was suspended";

/** A page for automation to give input to. */
const PRESSED = dataPage("<title>Automation's</title><button>press</button>");

/** Whether the member whose page it is holds the tab, as its page knows. */
const holds = (page: Page, tab: number) =>
  comes(
    page,
    `s.presence.held.some((held) => held.tab === ${tab} && held.holder === s.presence.you)`,
  );

const within = (page: Page, selector: string, text: string) =>
  happens(page.text(selector).pipe(Effect.map((shown) => shown?.includes(text) === true)));

const resize = (page: Page, width: number, height: number) =>
  page.cdp.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

/** Whether the element's sides are within the window's. */
const fitsWindow = (page: Page, selector: string) =>
  page.evaluate(
    `(() => {
      const rect = document.querySelector("${selector}").getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    })()`,
  );

/** What a member who only watches finds turned off, each by its name. */
const turnedOff = (page: Page): Effect.Effect<Record<string, boolean>, Error> =>
  page.evaluate(
    `(() => {
      const off = {};
      for (const label of ["Back", "Forward", "Reload", "New tab"]) {
        off[label] = document.querySelector(\`[aria-label="\${label}"]\`).disabled;
      }
      off["Address"] = document.querySelector("[data-workbench-address]").disabled;
      off["Close tab"] = [...document.querySelectorAll('[aria-label="Close tab"]')].every((button) => button.disabled);
      return off;
    })()`,
  );

const tabsAreSelected = (page: Page) =>
  page.evaluate(
    `[...document.querySelectorAll("[data-browser-tab] > button:not([aria-label])")].every((button) => !button.disabled)`,
  );

/** Loads the page anew with this script run before its own. */
const reloadWith = (page: Page, script: string) =>
  Effect.gen(function* () {
    yield* page.cdp.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `${script}; window.__reloaded = true;`,
    });
    yield* page.cdp.call("Page.reload", {});
    yield* page.until("window.__reloaded === true", 30_000);
  });

/** Has the page reach for its session at an address instead, whatever it asked for. */
const socketsGoTo = (url: string) => `
  window.WebSocket = class extends WebSocket {
    constructor(asked, protocols) {
      super(${JSON.stringify(url)}, protocols);
    }
  }`;

/**
 * Has the page keep the sockets it opens, and tell their closing with the reason in
 * `window.__closesWith` where there is one: a session served on its own gives none when it
 * closes, as one below an executor does.
 */
const KEEP_SOCKETS = `
  window.__sockets = [];
  window.WebSocket = class extends WebSocket {
    constructor(asked, protocols) {
      super(asked, protocols);
      window.__sockets.push(this);
      this.addEventListener("close", (closed) => {
        const reason = window.__closesWith;
        if (closed.isTrusted && reason !== undefined) {
          closed.stopImmediatePropagation();
          this.dispatchEvent(new CloseEvent("close", { code: closed.code, reason }));
        }
      });
    }
  }`;

/** Closes the page's connection to the session, as a session that says why does. */
const closeWith = (page: Page, reason: string) =>
  page.evaluate(
    `(() => {
      window.__closesWith = ${JSON.stringify(reason)};
      window.__sockets.at(-1).close();
    })()`,
  );

/** Something that takes connections and never answers them, until the scope ends. */
const silence = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ port: number; close: () => void }>((listening) => {
        const taken: Socket[] = [];
        const server = createServer((socket) => taken.push(socket));
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          listening({
            port: typeof address === "object" && address !== null ? address.port : 0,
            close: () => {
              for (const socket of taken) {
                socket.destroy();
              }
              server.close();
            },
          });
        });
      }),
  ),
  ({ close }) => Effect.sync(close),
).pipe(Effect.map(({ port }) => `ws://127.0.0.1:${port}/ws`));

suite(session)("the states the workbench shows", (it) => {
  let ada: Page;
  let bob: Page;
  let vera: Page;
  let operator: Page;
  let tab: number;
  let automated: number;

  const asThe = (access: Tickets.Access, name: string) =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const tickets = yield* Tickets.Tickets;
      const viewer = yield* Viewer;
      const ticket = tickets.ticket(access, { sub: name.toLowerCase(), name });
      return yield* viewer.open(runner.page({ token: ticket, fit: "0" }));
    });

  it.effect("whoever may not take a tab is told who holds it, and offered to ask", () =>
    Effect.gen(function* () {
      ada = yield* asThe(GIVES_INPUT, "Ada");
      bob = yield* asThe(GIVES_INPUT, "Bob");
      yield* ready(ada, 2);
      yield* ready(bob, 2);
      tab = yield* snapshot(ada, "s.selected");
      expect(yield* snapshot(bob, "s.selected")).toBe(tab);

      const picture = yield* pictureBox(ada);
      yield* ada.clickAt(picture.x, picture.y);
      expect(yield* holds(ada, tab)).toBe(true);

      expect(yield* appears(bob, lease("theirs"))).toBe(true);
      expect(yield* bob.text(LEASE)).toContain("Ada holds this tab");
      expect(yield* bob.text(LEASE)).toContain("Ask for the lease");
    }),
  );

  it.effect("asking tells the asker that it asked, and shows the holder a request", () =>
    Effect.gen(function* () {
      yield* bob.click(`${LEASE} button`);
      expect(yield* appears(bob, lease("you-asked"))).toBe(true);
      expect(yield* bob.text(LEASE)).toContain("Asked");
      expect(yield* appears(ada, lease("asked-of-you"))).toBe(true);
      expect(yield* ada.text(LEASE)).toContain("Bob asks for this tab");
    }),
  );

  it.effect("'Keep' leaves the tab with its holder", () =>
    Effect.gen(function* () {
      yield* clickElement(ada, buttonWithin(LEASE, "Keep"));
      expect(yield* leaves(ada, LEASE)).toBe(true);
      expect(yield* appears(bob, lease("theirs"))).toBe(true);
      expect(yield* holds(ada, tab)).toBe(true);
    }),
  );

  it.effect("a request fits a narrow window, and the browser menu offers the same answers", () =>
    Effect.gen(function* () {
      yield* bob.click(`${LEASE} button`);
      expect(yield* appears(ada, lease("asked-of-you"))).toBe(true);

      yield* resize(ada, 390, 700);
      yield* ada.until("innerWidth === 390");
      expect(yield* fitsWindow(ada, LEASE)).toBe(true);
      yield* resize(ada, 1280, 800);
      yield* ada.until("innerWidth === 1280");

      yield* openMenu(ada, "[data-workbench-menu]", "Keep the lease");
      expect(yield* hasItem(ada, "Allow Bob the lease")).toBe(true);
      yield* closeMenus(ada);
    }),
  );

  it.effect("'Allow' gives the tab to whoever asked", () =>
    Effect.gen(function* () {
      yield* clickElement(ada, buttonWithin(LEASE, "Allow"));
      expect(yield* holds(bob, tab)).toBe(true);
      expect(yield* leaves(bob, LEASE)).toBe(true);
      expect(yield* appears(ada, lease("theirs"))).toBe(true);
      expect(yield* ada.text(LEASE)).toContain("Bob holds this tab");
    }),
  );

  it.effect("a person takes a tab from automation at once", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const mcp = yield* Mcp.connect(runner.url, runner.token);
      automated = yield* openByAutomation(mcp, PRESSED);
      yield* mcp.call("click", { tab: automated, selector: "button" });

      yield* bob.evaluate(`apertureSession.select(${automated})`);
      expect(yield* appears(bob, lease("theirs"))).toBe(true);
      expect(yield* bob.text(LEASE)).toContain("Automation holds this tab");
      expect(yield* bob.text(LEASE)).toContain("Take the lease");
      yield* bob.click(`${LEASE} button`);
      expect(yield* holds(bob, automated)).toBe(true);
      yield* bob.evaluate(`apertureSession.select(${tab})`);
      yield* bob.until(`apertureSession.getSnapshot().selected === ${tab}`);
    }),
  );

  it.effect("a member who only watches is told so, and shown no lease", () =>
    Effect.gen(function* () {
      vera = yield* asThe(WATCHES, "Vera");
      yield* ready(vera, 3);
      expect(yield* appears(vera, "[data-session-view-only]")).toBe(true);
      // Bob holds the tab they all watch.
      expect(yield* has(vera, LEASE)).toBe(false);

      yield* openMenu(vera, "[data-workbench-menu]", "View only");
      yield* closeMenus(vera);
    }),
  );

  it.effect("who only watches goes nowhere and changes no tabs, and still selects them", () =>
    Effect.gen(function* () {
      expect(yield* turnedOff(vera)).toEqual({
        Back: true,
        Forward: true,
        Reload: true,
        "New tab": true,
        Address: true,
        "Close tab": true,
      });
      expect(yield* tabsAreSelected(vera)).toBe(true);
    }),
  );

  it.effect("recording is not offered to who may not record", () =>
    Effect.gen(function* () {
      yield* openMenu(vera, "[data-workbench-recording]", "Record this tab");
      const refused = yield* vera.evaluate(
        `(${menuItem("Record this tab")}).getAttribute("aria-disabled")`,
      );
      expect(refused).toBe("true");
      yield* closeMenus(vera);
    }),
  );

  it.effect("a session that does not answer yet is told as connecting", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      const unanswered = yield* silence;
      const waiting = yield* viewer.open(runner.page({ fit: "0" }));
      yield* reloadWith(waiting, socketsGoTo(unanswered));
      expect(yield* within(waiting, "[data-aperture-stage]", "Connecting to the session")).toBe(
        true,
      );
      yield* waiting.close;
    }),
  );

  it.effect("a connection that closed tells why, and offers to reconnect", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      operator = yield* viewer.open(runner.page({ fit: "0" }));
      yield* reloadWith(operator, KEEP_SOCKETS);
      yield* ready(operator);

      yield* closeWith(operator, SUSPENDED);
      expect(yield* appears(operator, CLOSED)).toBe(true);
      expect(yield* operator.text(CLOSED)).toContain(SUSPENDED);

      yield* operator.evaluate("delete window.__closesWith");
      yield* operator.click(`${CLOSED} button`);
      expect(yield* leaves(operator, CLOSED)).toBe(true);
      yield* ready(operator);
    }),
  );

  it.effect("a session with no tabs says so, and offers to open one", () =>
    Effect.gen(function* () {
      const open: readonly number[] = yield* snapshot(
        operator,
        "s.targets.map((target) => target.tab)",
      );
      for (const one of open) {
        yield* operator.evaluate(`apertureSession.closeTab(${one})`);
      }
      expect(yield* appears(operator, EMPTY)).toBe(true);

      yield* operator.click(`${EMPTY} button`);
      expect(yield* comes(operator, "s.targets.length === 1")).toBe(true);
      expect(yield* leaves(operator, EMPTY)).toBe(true);
    }),
  );

  it.effect("the pages threw nothing", () =>
    Effect.sync(() => {
      for (const page of [ada, bob, vera, operator]) {
        expect(page.errors()).toEqual([]);
      }
    }),
  );
});
