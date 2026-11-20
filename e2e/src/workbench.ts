import * as Effect from "effect/Effect";
import type * as Mcp from "./mcp.ts";
import { type Box, type Page, ready, snapshot } from "./viewer.ts";
import { happens } from "./wait.ts";

/** Everything a session offers, as the checks of the whole workbench need it. */
export const EVERY_FEATURE = [
  "sound",
  "uploads",
  "downloads",
  "recordings",
  "clipboard",
  "mcp",
  "cdp",
  "tunnel",
] as const;

/** The picture, whichever of its surfaces shows it now. */
const SHOWN_SURFACE = `[...document.querySelectorAll('[data-aperture-surface=video],[data-aperture-surface=canvas]')].find((surface) => surface.getBoundingClientRect().width > 0)`;

const MENU_ITEMS = "[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]";

/** The item of an open menu whose text starts with `label`, as the page finds it. */
export const menuItem = (label: string) =>
  `[...document.querySelectorAll('${MENU_ITEMS}')].find((item) => item.textContent.trim().startsWith(${JSON.stringify(label)}))`;

/** The button within `selector` whose text has `label` in it, as the page finds it. */
export const buttonWithin = (selector: string, label: string) =>
  `[...document.querySelectorAll(${JSON.stringify(`${selector} button`)})].find((button) => button.textContent.includes(${JSON.stringify(label)}))`;

/** A tab's button in the tab strip, which selects it. */
export const tabButton = (tab: number) => `[data-browser-tab][data-tab="${tab}"] button`;

const closeButton = (tab: number) =>
  `[data-browser-tab][data-tab="${tab}"] [aria-label="Close tab"]`;

/** Whether the page has an element the selector names. */
export const has = (page: Page, selector: string) =>
  page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Effect.Effect<
    boolean,
    Error
  >;

/** Whether an element the selector names comes within the time. */
export const appears = (page: Page, selector: string, withinMs?: number) =>
  happens(has(page, selector), withinMs);

/** Whether the element the selector names goes within the time. */
export const leaves = (page: Page, selector: string, withinMs?: number) =>
  happens(has(page, selector).pipe(Effect.map((there) => !there)), withinMs);

/** Where the element is that an expression gives in the page. */
export const boxOf = (page: Page, element: string): Effect.Effect<Box, Error> =>
  page
    .evaluate(
      `(() => {
        const element = ${element};
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
          left: rect.left,
          top: rect.top,
        };
      })()`,
    )
    .pipe(
      Effect.flatMap((found: Box | null) =>
        found === null ? Effect.fail(new Error(`no element is ${element}`)) : Effect.succeed(found),
      ),
    );

/** Clicks the element an expression gives in the page, once it is there. */
export const clickElement = (page: Page, element: string) =>
  Effect.gen(function* () {
    yield* page.until(`!!(${element})`);
    const at = yield* boxOf(page, element);
    yield* page.clickAt(at.x, at.y);
  });

/** Clicks the item of an open menu whose text starts with `label`, once it is there. */
export const clickItem = (page: Page, label: string) => clickElement(page, menuItem(label));

/** Whether an open menu has an item whose text starts with `label`. */
export const hasItem = (page: Page, label: string) =>
  page.evaluate(`!!(${menuItem(label)})`) as Effect.Effect<boolean, Error>;

/** Opens the menu of the toolbar button a selector names, and waits for one of its items. */
export const openMenu = (page: Page, button: string, item: string) =>
  Effect.gen(function* () {
    yield* page.click(button);
    yield* page.until(`!!(${menuItem(item)})`);
    // The menu moves into place as it opens; a click meant for an item waits that out.
    yield* Effect.sleep(300);
  });

export const escape = (page: Page) => page.key("Escape", "Escape", 27);

export const enter = (page: Page) => page.key("Enter", "Enter", 13);

/** Closes the menus that are open, submenus first. */
export const closeMenus = (page: Page) =>
  Effect.gen(function* () {
    for (let left = 3; left > 0; left -= 1) {
      if (!(yield* has(page, "[data-slot=dropdown-menu-content]"))) {
        return;
      }
      yield* escape(page);
      yield* Effect.sleep(200);
    }
  });

/** The watched tab's picture, whichever surface shows it. */
export const pictureBox = (page: Page) => boxOf(page, SHOWN_SURFACE);

/** Where in the window a point of the watched tab is, given in the tab's logical pixels. */
export const pictureAt = (
  page: Page,
  x: number,
  y: number,
): Effect.Effect<{ readonly x: number; readonly y: number }, Error> =>
  page.evaluate(
    `(() => {
      const session = apertureSession.getSnapshot();
      const watched = session.targets.find((target) => target.tab === session.selected);
      const rect = ${SHOWN_SURFACE}.getBoundingClientRect();
      return {
        x: rect.left + (${x} * rect.width) / watched.width,
        y: rect.top + (${y} * rect.height) / watched.height,
      };
    })()`,
  );

/** Clicks a point of the watched tab, given in the tab's logical pixels. */
export const clickPicture = (page: Page, x: number, y: number, button?: "left" | "right") =>
  Effect.gen(function* () {
    const at = yield* pictureAt(page, x, y);
    yield* page.clickAt(at.x, at.y, button);
    return at;
  });

/** Whether `holds` comes true of the session's snapshot `s` and its `watched` tab in time. */
export const comes = (page: Page, holds: string, withinMs?: number) =>
  happens(snapshot(page, holds), withinMs);

/** The numbers of the session's tabs, as the page knows them. */
export const tabNumbers = (page: Page): Effect.Effect<readonly number[], Error> =>
  snapshot(page, "s.targets.map((target) => target.tab)");

/** Selects a tab by its button in the tab strip, and tells whether it is watched then. */
export const selectTab = (page: Page, tab: number) =>
  Effect.gen(function* () {
    yield* page.click(tabButton(tab));
    return yield* comes(page, `s.selected === ${tab}`);
  });

/** Closes a tab by its button in the tab strip, and tells whether it went. */
export const closeTab = (page: Page, tab: number) =>
  Effect.gen(function* () {
    // The button shows where the pointer is over the tab.
    yield* page.hover(tabButton(tab));
    yield* page.click(closeButton(tab));
    return yield* comes(page, `!s.targets.some((target) => target.tab === ${tab})`);
  });

/** Types an address into the address bar and goes there. */
export const goTo = (page: Page, address: string) =>
  Effect.gen(function* () {
    yield* page.click("[data-workbench-address]");
    yield* page.type(address);
    yield* enter(page);
  });

/** Whether the tab comes to show an address that starts so. */
export const arrives = (page: Page, tab: number, address: string) =>
  comes(
    page,
    `s.targets.find((target) => target.tab === ${tab})?.url.startsWith(${JSON.stringify(address)})`,
    20_000,
  );

/** Gives the page's file input the files at these paths, as a person choosing them does. */
export const chooseFiles = (page: Page, input: string, paths: readonly string[]) =>
  Effect.gen(function* () {
    const { root } = yield* page.cdp.call("DOM.getDocument", {});
    const { nodeId } = yield* page.cdp.call("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: input,
    });
    yield* page.cdp.call("DOM.setFileInputFiles", { nodeId, files: paths });
  });

/** A page that is this HTML, as an address automation opens. A client's `go` takes none. */
export const dataPage = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

/** Has automation open a page in a tab of its own, and gives the tab's number. */
export const openByAutomation = (mcp: Mcp.Mcp, url: string) =>
  mcp
    .call("navigate", { url })
    .pipe(Effect.map((answer) => (JSON.parse(answer) as { tab: number }).tab));

/** What an expression is in a tab's page, as automation evaluates it. */
export const inTab = (mcp: Mcp.Mcp, tab: number, expression: string) =>
  mcp
    .call("eval", { tab, expression, world: "main" })
    .pipe(Effect.map((answer) => JSON.parse(answer) as unknown));

/** The session's tabs as automation lists them. */
export const tabsOfAutomation = (mcp: Mcp.Mcp) =>
  mcp
    .call("tabs")
    .pipe(
      Effect.map(
        (answer) => JSON.parse(answer) as readonly { tab: number; target: string; url: string }[],
      ),
    );

const KEEP_WHAT_IS_SAID = `(() => {
  window.__said = { errors: [] };
  const error = console.error;
  console.error = (...said) => {
    window.__said.errors.push(said.map(String).join(" "));
    error.apply(console, said);
  };
  performance.setResourceTimingBufferSize(5000);
})()`;

/**
 * Has the page keep what it logs as errors, from its first script on: the viewer's pages
 * keep what they throw and nothing of their console. The page is loaded anew for it.
 */
export const keepErrors = (page: Page, members = 1) =>
  Effect.gen(function* () {
    yield* page.cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: KEEP_WHAT_IS_SAID });
    yield* page.cdp.call("Page.reload", {});
    yield* page.until("window.__said !== undefined", 30_000);
    yield* ready(page, members);
  });

/** The errors the page logged since `keepErrors`. */
export const loggedErrors = (page: Page): Effect.Effect<readonly string[], Error> =>
  page.evaluate("window.__said.errors");

/** What the page loaded that its own origin did not serve. */
export const askedOfOthers = (page: Page): Effect.Effect<readonly string[], Error> =>
  page.evaluate(
    `performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => !url.startsWith(location.origin) && !url.startsWith("data:") && !url.startsWith("blob:"))`,
  );
