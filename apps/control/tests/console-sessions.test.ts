import * as Mcp from "@aperture-browser/e2e/src/mcp.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import * as Proxy from "./src/proxy.ts";
import {
  AUTO,
  BACKSPACE,
  BODY,
  BUTTONS,
  DARK,
  DIALOG,
  EDGE,
  ENTER,
  ESCAPE,
  LONG,
  alike,
  choose,
  closed,
  fromMenu,
  nameToken,
  needs,
  noteStarting,
  placed,
  pressUntil,
  rested,
  shot,
  signInWithToken,
  snug,
  stands,
  started,
  toAccount,
  withSession,
} from "./src/console.ts";

suite(needs)("the console's sessions, behind the proxy", (it) => {
  let ada: Effect.Success<ReturnType<typeof Control.account>>;
  let path = "";

  it.effect(
    "the console signs in with a token, lists the session and opens it",
    () =>
      Effect.gen(function* () {
        ({ account: ada, path } = yield* withSession("Ada"));
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const page = yield* viewer.open(`${proxy.url}/`);
        yield* signInWithToken(page, ada.token);

        const id = path.split("/").at(-1) ?? "";
        const card = `[data-console-session="${id}"]`;
        yield* page.until(`!!document.querySelector(${JSON.stringify(card)})`);
        // The card shows what the session shows: a picture asked of the session at its path.
        yield* page.until(
          `document.querySelector(${JSON.stringify(`${card} img`)})?.naturalWidth > 0`,
          "30 seconds",
        );
        yield* ada.api.sessions.describe({
          params: { id },
          payload: { label: "Checkout flow", tags: { team: "shop" } },
        });
        yield* page.until(`!!document.querySelector('${card} [data-console-tag="team=shop"]')`);
        expect(yield* page.text(card)).toContain("Checkout flow");
        yield* shot(page, fs, "console-sessions");
        // A card has one shape whatever it shows, and says what it is over the foot of its picture.
        expect(
          yield* page.evaluate(
            `(() => {
            const card = document.querySelector(${JSON.stringify(card)});
            const footer = card.querySelector("[data-console-session-footer]");
            const [whole, foot, picture] = [card, footer, card.querySelector("img")].map((one) => one.getBoundingClientRect());
            return {
              shape: Math.abs(whole.width / whole.height - 4 / 3) < 0.02,
              over: foot.bottom <= whole.bottom + 1 && foot.top > picture.top && picture.bottom >= foot.bottom - 1,
              blurred: getComputedStyle(footer).backdropFilter.includes("blur"),
            };
          })()`,
          ),
        ).toEqual({ shape: true, over: true, blurred: true });

        // A right click on the card offers what its button does.
        const at = yield* page.box(card);
        yield* page.clickAt(at.x, at.y - 40, "right");
        yield* page.until(`!!document.querySelector("[data-console-session-context]")`);
        expect(yield* page.text("[data-console-session-context]")).toContain("Save to snapshot");
        yield* shot(page, fs, "console-context-menu");
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector("[data-console-session-context]")`);

        // What is selected is acted on from a bar that floats over the sessions.
        yield* page.click(`${card} input[type="checkbox"]`);
        yield* page.until(`!!document.querySelector("[data-console-bulk]")`);
        // It is in the middle of the page, which the sidebar is no part of.
        expect(
          yield* page.evaluate(
            `(() => {
            const middle = (one) => { const box = one.getBoundingClientRect(); return (box.left + box.right) / 2; };
            const page = document.querySelector('[data-slot="sidebar-inset"]');
            return page.getBoundingClientRect().left > 0 && Math.abs(middle(document.querySelector("[data-console-bulk]")) - middle(page)) < 1;
          })()`,
          ),
        ).toBe(true);
        yield* shot(page, fs, "console-bulk");
        yield* page.click(`${card} [aria-label="Session actions"]`);
        yield* page.until(`!!document.querySelector('[data-slot="dropdown-menu-content"]')`);
        yield* shot(page, fs, "console-session-menu");
        yield* page.key("Escape", "Escape", ESCAPE);
        // The menu holds the page until it is gone.
        yield* page.until(`!document.querySelector('[data-slot="dropdown-menu-content"]')`);
        yield* page.click(`[data-console-bulk] [aria-label="Clear selection"]`);
        yield* page.until(`!document.querySelector("[data-console-bulk]")`);

        // A token is made in the page, and told there once.
        yield* Effect.forEach(
          Array.from({ length: 40 }, (_, at) => `filler ${at}`),
          (name) =>
            ada.api.accounts.createOwnToken({ payload: { name, scopes: ["sessions:read"] } }),
          { concurrency: 8 },
        );
        yield* toAccount(page, "tokens");
        yield* page.until(`!!document.querySelector('[data-console-token="checks"]')`);
        yield* page.click("[data-console-token-new]");
        yield* page.until(`!!document.querySelector("[data-console-token-create] input")`);
        // A token with no name is not asked for: the field says what it lacks.
        yield* page.key("Enter", "Enter", ENTER);
        yield* page.until(
          `!!document.querySelector('[data-console-token-create] [data-slot="field-error"]')`,
        );
        // Nor one that does nothing: a scope is ticked, and the token is held to it.
        expect(yield* page.text("[data-console-token-create]")).toContain(
          "Tick at least one scope.",
        );
        yield* page.click(`[data-console-scope="sessions:read"]`);
        yield* page.until(
          `document.querySelector('[data-console-scope="sessions:read"]').hasAttribute("data-checked")`,
        );
        // It reaches all the account does, or only what is chosen: here the one session.
        const search = `document.querySelector("[data-console-token-resources-search]")`;
        yield* page.click("[data-console-token-resources]");
        yield* page.until(`document.activeElement === ${search}`);
        yield* page.type("Checkout");
        const resource = `[data-console-token-resource="sessions:${id}"]`;
        yield* page.until(`!!document.querySelector('${resource}')`);
        yield* page.click(resource);
        yield* page.until(
          `!!document.querySelector('[data-console-token-resource-chosen="sessions:${id}"]')`,
        );
        yield* shot(page, fs, "console-token-resources");
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!${search}`);
        yield* page.click(`[data-console-token-create] input[name="name"]`);
        yield* page.type("from the console");
        yield* shot(page, fs, "console-token-create");
        yield* page.key("Enter", "Enter", ENTER);
        yield* page.until(`!!document.querySelector("[data-console-secret]")`);
        const secret = (yield* page.text("[data-console-secret]")) ?? "";
        expect(secret).toMatch(/^apc_/u);
        const withIt = yield* (yield* Control.Control).as(secret);
        expect((yield* withIt.accounts.current()).id).toBe(ada.account.id);
        expect((yield* withIt.sessions.list({ query: {} })).map((session) => session.id)).toEqual([
          id,
        ]);
        expect((yield* Effect.flip(withIt.snapshots.list({ query: {} })))._tag).toBe("Forbidden");
        const held = (yield* ada.api.accounts.tokens()).find(
          (token) => token.name === "from the console",
        );
        expect([held?.scopes, held?.resources]).toEqual([
          ["sessions:read"],
          { workspaces: [], sessions: [id], snapshots: [] },
        ]);
        yield* shot(page, fs, "console-token");
        // It is shown once: Escape does not take it away, and the button that says so does.
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* rested(page);
        expect(yield* page.evaluate(`!!document.querySelector("[data-console-secret]")`)).toBe(
          true,
        );
        yield* choose(page, `${DIALOG} button`, "Done");
        // What it shows stays while it closes, and the table tells what the token is held to.
        yield* page.until(`!document.querySelector("[data-console-secret]")`);
        const row = `[data-console-token="from the console"]`;
        yield* page.until(
          `!!document.querySelector('${row} [data-console-token-scope="sessions:read"]')`,
        );
        expect(yield* page.text(`${row} [data-console-token-resource="sessions"]`)).toBe(
          "1 session",
        );
        // The table scrolls within the page, under a header that stays, and tells by a shadow
        // that there is more above.
        expect(
          yield* page.evaluate(
            `(() => {
            const shell = document.querySelector('[data-slot="table-container"]');
            const viewport = shell.querySelector('[data-slot="scroll-area-viewport"]');
            const head = () => shell.querySelector('[data-slot="table-head"]').getBoundingClientRect().top;
            const before = head();
            viewport.scrollTop = 200;
            return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done({
              scrolled: viewport.scrollTop,
              pinned: head() === before,
              within: shell.getBoundingClientRect().bottom <= innerHeight,
            }))));
          })()`,
          ),
        ).toEqual({ scrolled: 200, pinned: true, within: true });
        yield* page.until(
          `document.querySelector('[data-slot="table-container"] [data-slot="scroll-area"]').hasAttribute("data-overflow-y-start")`,
        );
        yield* shot(page, fs, "console-tokens");

        // How an MCP client reaches every session is told beside what is connected already,
        // in a dialog in the window's middle: by signing in.
        yield* toAccount(page, "connections");
        expect(
          yield* page.evaluate(`document.querySelectorAll("[data-console-mcp-open]").length`),
        ).toBeGreaterThan(0);
        expect(
          yield* page.evaluate(
            `!!document.querySelector('[data-slot="sidebar"] [data-console-mcp-open]')`,
          ),
        ).toBe(false);
        yield* page.click("[data-console-mcp-open]");
        yield* page.until(`!!document.querySelector('[data-console-mcp-auth="oauth"] code')`);
        yield* placed(page, `${DIALOG} [data-console-mcp]`);
        expect(yield* stands(page)).toBe("middle");
        const signingIn = (yield* page.text("[data-console-mcp]")) ?? "";
        expect(signingIn).toContain(`claude mcp add --transport http aperture '${proxy.url}/mcp'`);
        expect(signingIn).not.toContain("Bearer");
        yield* shot(page, fs, "console-mcp");
        // Each client is told its own way.
        yield* pressUntil(
          page,
          `[data-console-mcp-client="cursor"]`,
          `(document.querySelector("[data-console-mcp]")?.textContent ?? "").includes("~/.cursor/mcp.json")`,
        );
        yield* shot(page, fs, "console-mcp-cursor");
        yield* page.click(`[data-console-mcp-client="claude-code"]`);
        // The other way in is a token, and the dialog is as tall for it.
        const tall = `document.querySelector('[data-slot="dialog-content"]').getBoundingClientRect().height`;
        const signingInTall = yield* page.evaluate(tall);
        yield* page.click(`[data-console-mcp-way="token"]`);
        yield* page.until(`!!document.querySelector('[data-console-mcp-auth="token"]')`);
        expect(yield* page.text("[data-console-mcp]")).toContain(
          "Authorization: Bearer $APERTURE_TOKEN",
        );
        expect(yield* page.evaluate(tall)).toBe(signingInTall);
        // A token made from there is put where the steps want one, and reaches every session.
        yield* page.click("[data-console-mcp-token]");
        yield* page.until(
          `document.querySelector('[data-console-token-create] [data-console-scope="sessions:write"]')?.hasAttribute("data-checked") === true`,
        );
        yield* nameToken(page, "for an MCP client");
        yield* page.until(
          `/Bearer apc_/u.test(document.querySelector("[data-console-mcp]")?.textContent ?? "")`,
        );
        yield* page.until(`!document.querySelector("[data-console-token-create]")`);
        yield* shot(page, fs, "console-mcp-token");
        const forMcp = /Bearer (apc_[\w-]+)/u.exec((yield* page.text("[data-console-mcp]")) ?? "");
        const everywhere = yield* Mcp.connect(proxy.url, forMcp?.[1] ?? "");
        expect(yield* everywhere.tools).toEqual(
          expect.arrayContaining(["sessions.create", "navigate"]),
        );
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector("[data-console-mcp]")`);

        // A session's own server is told from the session, with a token for that session.
        yield* page.click(`a[href="/-/sessions"]`);
        yield* page.until(`!!document.querySelector(${JSON.stringify(card)})`);
        yield* page.click(`${card} [aria-label="Session actions"]`);
        yield* choose(page, `[data-slot="dropdown-menu-item"]`, "Connect MCP");
        yield* page.until(`!!document.querySelector("[data-console-session-mcp]")`);
        expect(yield* page.text("[data-console-mcp-endpoint]")).toBe(`${proxy.url}${path}/mcp`);
        yield* page.click("[data-console-mcp-token]");
        yield* page.until(
          `!!document.querySelector('[data-console-token-resource-chosen="sessions:${id}"]')`,
        );
        yield* nameToken(page, "for one session");
        yield* page.until(
          `/Bearer apc_/u.test(document.querySelector('[data-slot="dialog-body"]')?.textContent ?? "")`,
        );
        yield* page.until(`!document.querySelector("[data-console-token-create]")`);
        yield* shot(page, fs, "console-session-mcp");
        const forSession = /Bearer (apc_[\w-]+)/u.exec(
          (yield* page.text(`[data-slot="dialog-body"]`)) ?? "",
        );
        const client = yield* Mcp.connect(`${proxy.url}${path}`, forSession?.[1] ?? "");
        expect((yield* client.tools).length).toBeGreaterThan(0);
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector("[data-console-session-mcp]")`);

        yield* ada.api.snapshots.take({ params: { id }, payload: { name: "signed in" } });
        yield* page.click(`a[href="/-/snapshots"]`);
        yield* page.until(`!!document.querySelector("[data-console-snapshot]")`);
        yield* shot(page, fs, "console-snapshots");

        // A session from a snapshot is opened at once, before there is one.
        yield* noteStarting(page);
        yield* page.click(`[data-console-snapshot] [data-console-row-action="start"]`);
        const fromSnapshot = yield* started(page);
        expect((yield* ada.api.sessions.get({ params: { id: fromSnapshot } })).snapshotId).not.toBe(
          null,
        );

        yield* page.evaluate(`void (location.href = "/-/sessions")`);
        yield* page.until(`!!document.querySelector(${JSON.stringify(card)})`);

        // The session is saved in the place of the snapshot there is, which keeps its name.
        const [replaced] = yield* ada.api.snapshots.list({ query: {} });
        yield* page.click(`${card} [aria-label="Session actions"]`);
        yield* choose(page, `[data-slot="dropdown-menu-item"]`, "Save to snapshot");
        const save = "[data-console-save-snapshot]";
        yield* page.until(`!!document.querySelector('${save} input[name="name"]')`);
        // A dialog that is still growing into place moves what is pressed from under the press.
        yield* page.until(
          `document.querySelector('${save}')?.closest('[data-slot="dialog-content"]').getAnimations().length === 0`,
        );
        yield* shot(page, fs, "console-save-snapshot");
        yield* page.click(`${save} [data-console-save-snapshot-mode="replace"]`);
        yield* page.until(
          `(document.querySelector('${save} [data-slot="select-trigger"]')?.textContent ?? "").includes("signed in")`,
        );
        yield* page.click(`${save} textarea`);
        yield* page.type("After the checkout");
        yield* shot(page, fs, "console-save-snapshot-replace");
        yield* page.click(`${save} button[type="submit"]`);
        yield* page.until(`!document.querySelector('${save}')`, "60 seconds");
        const kept = yield* ada.api.snapshots.list({ query: {} });
        expect(kept.map((snapshot) => [snapshot.name, snapshot.description])).toEqual([
          ["signed in", "After the checkout"],
        ]);
        expect(kept[0]?.id).not.toBe(replaced?.id);

        yield* page.click(`${card} [data-console-session-open]`);
        yield* page.until(`location.pathname === ${JSON.stringify(`/-/sessions/${id}`)}`);
        // The picture is there once the session's socket, which went through the proxy, is.
        yield* page.until(
          `[...document.querySelectorAll("[data-aperture-surface]")].some((surface) => surface.getBoundingClientRect().width > 0)`,
          "30 seconds",
        );
        yield* shot(page, fs, "console-session");
        // The sidebar is out of the way there, and comes when the pointer rests at the edge,
        // which is felt once the workbench has laid itself out.
        yield* page.mouse("mouseMoved", 400, 300);
        yield* page.hover(EDGE);
        yield* page.until(`!!document.querySelector('[data-slot="sidebar-container"][data-peek]')`);
        yield* shot(page, fs, "console-session-sidebar");
        yield* page.mouse("mouseMoved", 600, 300);
        yield* page.until(`!document.querySelector('[data-slot="sidebar-container"][data-peek]')`);

        // A small window has the sidebar the same way, and by a button before the tabs.
        const small = yield* viewer.open(`${proxy.url}/-/sessions/${id}`, {
          width: 700,
          height: 300,
        });
        yield* small.until(
          `[...document.querySelectorAll("[data-aperture-surface]")].some((surface) => surface.getBoundingClientRect().width > 0)`,
          "30 seconds",
        );
        expect(
          yield* small.evaluate(
            `!!document.querySelector("[data-workbench-titlebar] [data-console-sidebar-trigger]")`,
          ),
        ).toBe(true);
        // What it holds stays while it is closed, for the dialogs that are opened from it.
        const sheet = `!!document.querySelector('[data-slot="sidebar"][data-mobile="true"][data-open]')`;
        yield* small.mouse("mouseMoved", 300, 200);
        yield* small.hover(EDGE);
        yield* small.until(sheet);
        yield* shot(small, fs, "console-session-small-sidebar");
        // Beside it, on what it lies over.
        yield* small.clickAt(600, 150);
        yield* small.until(`!(${sheet})`);
        // The toolbar's menu opens below it and stays there, however little room that is.
        yield* small.click("[data-workbench-menu]");
        yield* small.until(`!!document.querySelector('[data-slot="dropdown-menu-content"]')`);
        yield* shot(small, fs, "console-session-small-menu");
        expect(
          yield* small.evaluate(
            `(() => {
            const menu = document.querySelector('[data-slot="dropdown-menu-content"]').getBoundingClientRect();
            const toolbar = document.querySelector("[data-workbench-toolbar]").getBoundingClientRect();
            return menu.top >= toolbar.bottom - 1 && menu.bottom <= innerHeight && menu.height > 0;
          })()`,
          ),
        ).toBe(true);
        yield* small.key("Escape", "Escape", ESCAPE);
        yield* small.until(`!document.querySelector('[data-slot="dropdown-menu-content"]')`);
        // A line parts the groups of the menu that show something, in the console as anywhere.
        yield* page.click("[data-workbench-menu]");
        yield* page.until(`!!document.querySelector('[data-slot="dropdown-menu-content"]')`);
        expect(
          yield* page.evaluate(
            `(() => {
            const shown = [...document.querySelectorAll('[data-slot="dropdown-menu-content"] > [data-workbench-menu-group]')].filter((group) => group.childElementCount > 0);
            const parted = shown.filter((group) => getComputedStyle(group, "::before").height === "1px");
            return shown.length > 2 && parted.length === shown.length - 1 && parted[0] !== shown[0];
          })()`,
          ),
        ).toBe(true);
        yield* shot(page, fs, "console-session-browser-menu");
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector('[data-slot="dropdown-menu-content"]')`);

        // With another there to draw for, the pencil is taken up, and Escape puts it down.
        const draws = `document.querySelector("[data-member-marks]")?.dataset.memberMarks === "drawing"`;
        yield* page.until(`!!document.querySelector("[data-workbench-draw]")`);
        yield* page.click("[data-workbench-draw]");
        yield* page.until(draws);
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!(${draws})`);
        yield* small.close;

        // The sidebar keeps the session at hand, with a glimpse of what it shows.
        yield* page.evaluate(`void (location.href = "/-/sessions")`);
        yield* page.until(
          `document.querySelector(${JSON.stringify(`[data-console-recent="${id}"] img`)})?.naturalWidth > 0`,
          "30 seconds",
        );
        yield* shot(page, fs, "console-sidebar");

        // A session is made as it is asked for in the dialog, and opened at once.
        yield* page.click("[data-console-create-custom]");
        yield* page.until(`!!document.querySelector("[data-console-session-create] input")`);
        yield* page.click("[data-console-session-create] input");
        yield* page.type("Made in a dialog");
        yield* shot(page, fs, "console-create");
        // Its tags are edited within the dialog's width, with nothing to scroll sideways for.
        yield* page.click(`[data-console-session-create] [role="tab"]:nth-of-type(3)`);
        yield* page.until(`!!document.querySelector('[aria-label="Add tag"]')`);
        // A press right after the tab changes is not always taken, so it is pressed until it is.
        yield* until(
          "a tag to fill in",
          page
            .click(`[aria-label="Add tag"]`)
            .pipe(
              Effect.andThen(
                page.evaluate(
                  `!!document.querySelector('[data-console-session-create] input[placeholder="key"]')`,
                ),
              ),
            ),
        );
        yield* page.type("kind");
        expect(
          yield* page.evaluate(
            `(() => {
            const dialog = document.querySelector("[data-slot=dialog-content]").getBoundingClientRect();
            const add = document.querySelector('[aria-label="Add tag"]').getBoundingClientRect();
            const scrolls = [...document.querySelectorAll("[data-console-session-create] *")].some(
              (one) => one.scrollWidth > one.clientWidth + 1 && getComputedStyle(one).overflowX !== "visible",
            );
            return add.right <= dialog.right && !scrolls;
          })()`,
          ),
        ).toBe(true);
        yield* shot(page, fs, "console-create-tags");
        const before = yield* page.evaluate("history.length", Schema.Number);
        yield* noteStarting(page);
        yield* page.key("Enter", "Enter", ENTER);
        const made = yield* started(page);
        expect((yield* ada.api.sessions.get({ params: { id: made } })).label).toBe(
          "Made in a dialog",
        );
        // The address it was opened at is not one to go back to.
        expect(yield* page.evaluate("history.length", Schema.Number)).toBe(before + 1);

        // A session that is not made says so where it was opened, with the way back.
        yield* page.evaluate(`void (location.href = "/-/sessions")`);
        yield* page.until(`!!document.querySelector("[data-console-create]")`);
        yield* page.cdp.call("Network.enable", {});
        yield* page.cdp.call("Network.setBlockedURLs", { urls: ["*/api/control/sessions"] });
        yield* page.click("[data-console-create]");
        yield* page.until(`!!document.querySelector('[data-console-session-note="failed"]')`);
        expect(yield* page.text(`[data-console-session-note="failed"]`)).toContain("not created");
        yield* shot(page, fs, "console-session-failed");
        // It has the whole of the workbench's room, and stands in the middle of it.
        expect(
          yield* page.evaluate(
            `document.querySelector('[data-console-session-note="failed"]').getBoundingClientRect().height === innerHeight`,
          ),
        ).toBe(true);
        yield* page.cdp.call("Network.setBlockedURLs", { urls: [] });
        yield* page.click(`[data-console-session-note="failed"] a[href="/-/sessions"]`);
        yield* page.until(`!!document.querySelector(${JSON.stringify(card)})`);

        // A workspace is made and selected, and shows what is its own: nothing yet.
        yield* page.evaluate(`void (location.href = "/-/workspaces")`);
        yield* page.until(`!!document.querySelector("[data-console-workspace-new]")`);
        yield* page.click("[data-console-workspace-new]");
        yield* page.until(`!!document.querySelector("[data-console-name-dialog] input")`);
        yield* page.click("[data-console-name-dialog] input");
        yield* page.type("Shop team");
        yield* page.key("Enter", "Enter", ENTER);
        yield* page.until(`!!document.querySelector('[data-console-workspace="Shop team"]')`);
        // It is selected once the page is told it was made, which may be after the list of
        // workspaces was asked for again and has it.
        yield* page.until(
          `document.querySelector("[data-console-workspace-switcher]").textContent.includes("Shop team")`,
        );
        yield* page.until(`!document.querySelector("[data-console-name-dialog]")`);
        yield* shot(page, fs, "console-workspaces");
        // A workspace with nothing in it yet says so, and offers to make the first.
        yield* page.click(`a[href="/-/sessions"]`);
        yield* page.until(
          `!!document.querySelector('[data-console-empty="none"] button') && !document.querySelector("[data-console-clear-filters]")`,
        );
        expect(page.errors()).toEqual([]);
      }),
    // It starts sessions and saves them several times over, and takes most of the time
    // any check gets where the machine is busy with something else.
    LONG,
  );

  it.effect(
    "a dialog keeps its height and its buttons their place, whatever it shows",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const id = path.split("/").at(-1) ?? "";
        const card = `[data-console-session="${id}"]`;
        const page = yield* viewer.open(`${proxy.url}/-/sessions`);
        // The session is none of the workspace that was made and selected.
        yield* page.until(`!!document.querySelector("[data-console-workspace-switcher]")`);
        yield* page.click("[data-console-workspace-switcher]");
        yield* choose(page, `[role="menuitemradio"]`, "Personal");
        yield* page.until(`!!document.querySelector(${JSON.stringify(card)})`);
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector('[role="menuitemradio"]')`);

        // What is known of the session is in tabs of one dialog at the window's side, which
        // is as tall and as wide for each.
        const tabs = `${DIALOG} [data-slot="tabs-list"]`;
        yield* fromMenu(page, card, "Details");
        const details = [yield* placed(page, tabs)];
        expect(yield* stands(page)).toBe("side");
        yield* shot(page, fs, "console-details");
        yield* page.click(`${DIALOG} [role="tab"]:nth-of-type(2)`);
        yield* page.until(
          `(document.querySelector('${DIALOG}')?.textContent ?? "").includes("DevTools")`,
        );
        yield* shot(page, fs, "console-details-connection");
        details.push(yield* placed(page, tabs));
        alike(details);
        yield* closed(page);

        // Its label and tags are edited with the buttons where they were, however many tags.
        yield* fromMenu(page, card, "Edit details");
        yield* page.until(`!!document.querySelector("[data-console-describe] input")`);
        const describing = [yield* placed(page)];
        yield* shot(page, fs, "console-describe");
        for (const rows of [2, 3, 4, 5]) {
          yield* page.click(`${DIALOG} [aria-label="Add tag"]`);
          yield* page.until(
            `document.querySelectorAll('${DIALOG} input[placeholder="key"]').length === ${rows}`,
          );
        }
        yield* shot(page, fs, "console-describe-tags");
        describing.push(yield* placed(page));
        alike(describing);
        yield* closed(page);

        // Its proxy is asked for and then edited in a dialog that is as tall all along: a
        // proxy for everything in the field at the top, the routes below it, and more
        // upstreams for whoever asks for them.
        yield* fromMenu(page, card, "Edit proxy");
        const routed = [yield* placed(page)];
        const proxied = "[data-console-session-proxy] [data-console-proxy]";
        const routes = (within: string) =>
          `document.querySelectorAll('${within} [data-console-proxy-route]').length`;
        /** Adds an exception, a route and two upstreams to the proxy that is edited. */
        const routesAdded = (within: string) =>
          Effect.gen(function* () {
            for (const pressed of [
              "exception",
              "route-add",
              "advanced",
              "upstream-add",
              "upstream-add",
            ]) {
              yield* page.click(`${within} [data-console-proxy-${pressed}]`);
            }
            yield* page.until(
              `${routes(within)} === 3 && document.querySelectorAll('${within} [data-console-proxy-upstream]').length === 2`,
            );
          });
        yield* page.until(`!!document.querySelector('${proxied}')`);
        expect(yield* page.text(`${DIALOG} [data-slot="dialog-title"]`)).toBe("Proxy");
        expect(yield* page.evaluate(routes(DIALOG))).toBe(0);
        yield* shot(page, fs, "console-routing");
        routed.push(yield* placed(page));
        // What is typed at the top is the proxy everything goes through: the one route says so.
        yield* pressUntil(
          page,
          `${DIALOG} input[name="proxy-url"]`,
          `document.activeElement === document.querySelector('${DIALOG} input[name="proxy-url"]')`,
        );
        yield* page.type("nowhere");
        yield* page.until(`${routes(DIALOG)} === 1`);
        expect(
          yield* page.evaluate(
            `document.querySelector('${DIALOG} [aria-label="Route 1 host"]').value`,
          ),
        ).toBe("*");
        routed.push(yield* placed(page));
        // What is no proxy's address is not kept, which is said at the field.
        yield* page.click(`${DIALOG} button[type="submit"]`);
        yield* page.until(`!!document.querySelector('${proxied} [data-slot="field-error"]')`);
        routed.push(yield* placed(page));
        yield* routesAdded(DIALOG);
        yield* shot(page, fs, "console-routing-rules");
        routed.push(yield* placed(page));
        alike(routed);
        yield* closed(page);

        // Replacing a snapshot asks for other things than saving a new one does.
        yield* fromMenu(page, card, "Save to snapshot");
        const save = "[data-console-save-snapshot]";
        yield* page.until(`!!document.querySelector('${save} [data-console-save-snapshot-mode]')`);
        const saving = [yield* placed(page)];
        yield* shot(page, fs, "console-save-snapshot-states");
        const other = yield* page.evaluate(
          `document.querySelector('${save} input[name="name"]') ? "replace" : "new"`,
          Schema.String,
        );
        yield* page.click(`${save} [data-console-save-snapshot-mode="${other}"]`);
        yield* page.until(
          `!!document.querySelector('${save} input[name="name"]') === ${JSON.stringify(other === "new")}`,
        );
        saving.push(yield* placed(page));
        const tags = yield* page.evaluate(
          `document.querySelectorAll('${DIALOG} input[placeholder="key"]').length`,
          Schema.Number,
        );
        for (const rows of [1, 2, 3, 4]) {
          yield* page.click(`${DIALOG} [aria-label="Add tag"]`);
          yield* page.until(
            `document.querySelectorAll('${DIALOG} input[placeholder="key"]').length === ${tags + rows}`,
          );
        }
        yield* shot(page, fs, "console-save-snapshot-tags");
        saving.push(yield* placed(page));
        alike(saving);
        yield* closed(page);

        // A new session is asked for in a dialog that is as tall, with its buttons where they
        // were, whatever tab and proxy it shows.
        yield* page.click("[data-console-create-custom]");
        const create = "[data-console-session-create]";
        yield* page.until(`!!document.querySelector("${create} input")`);
        yield* page.click(`${create} input`);
        yield* page.type("Made in a dialog");
        yield* shot(page, fs, "console-create-general");
        const creating = [yield* placed(page)];
        const tab = (at: number) => page.click(`${DIALOG} [role="tab"]:nth-of-type(${at})`);
        yield* tab(2);
        yield* page.until(`!!document.querySelector("${create} [data-console-proxy]")`);
        yield* shot(page, fs, "console-create-routing");
        creating.push(yield* placed(page));
        // A press right after the tab changes is not always taken.
        yield* pressUntil(
          page,
          `${create} input[name="proxy-url"]`,
          `document.activeElement === document.querySelector('${create} input[name="proxy-url"]')`,
        );
        yield* page.type("socks5://proxy.example.test:1080");
        yield* page.until(`${routes(create)} === 1`);
        yield* shot(page, fs, "console-create-routing-proxy");
        creating.push(yield* placed(page));
        yield* routesAdded(create);
        yield* shot(page, fs, "console-create-rules");
        creating.push(yield* placed(page));
        // Rules that are not filled in are not kept, which is said where it is seen.
        yield* page.click(`${DIALOG} button[type="submit"]`);
        yield* page.until(`!!document.querySelector('${create} [data-slot="field-error"]')`);
        expect(
          yield* page.evaluate(
            `(() => {
            const said = document.querySelector('${create} [data-slot="field-error"]').getBoundingClientRect();
            const body = document.querySelector('${BODY}').getBoundingClientRect();
            return said.top >= body.top && said.bottom <= body.bottom;
          })()`,
          ),
        ).toBe(true);
        creating.push(yield* placed(page));
        // Taken back row by row, and the proxy with what was typed of it: all goes direct again.
        const removes = `${create} [aria-label="Remove route"], ${create} [aria-label="Remove upstream"]`;
        yield* until(
          "the routes and the upstreams being removed",
          Effect.gen(function* () {
            if (!(yield* page.evaluate(`!!document.querySelector('${removes}')`, Schema.Boolean))) {
              return true;
            }
            yield* page.evaluate(`void document.querySelector('${removes}').click()`);
            return false;
          }),
        );
        yield* page.evaluate(
          `void (document.querySelector('${create} input[name="proxy-url"]').scrollIntoView({ block: "nearest" }), document.querySelector('${create} input[name="proxy-url"]').select())`,
        );
        yield* pressUntil(
          page,
          `${create} input[name="proxy-url"]`,
          `document.activeElement === document.querySelector('${create} input[name="proxy-url"]')`,
        );
        yield* page.evaluate(
          `void document.querySelector('${create} input[name="proxy-url"]').select()`,
        );
        yield* page.key("Backspace", "Backspace", BACKSPACE);
        yield* page.until(
          `document.querySelector('${create} input[name="proxy-url"]').value === "" && ${routes(create)} === 0`,
        );
        yield* tab(3);
        yield* page.until(`!!document.querySelector('[aria-label="Add tag"]')`);
        creating.push(yield* placed(page));
        // A press right after the tab changes is not always taken.
        for (const rows of [1, 2, 3, 4]) {
          yield* pressUntil(
            page,
            `[aria-label="Add tag"]`,
            `document.querySelectorAll('${create} input[placeholder="key"]').length === ${rows}`,
          );
        }
        yield* shot(page, fs, "console-create-many-tags");
        creating.push(yield* placed(page));
        alike(creating);
        yield* closed(page);

        yield* page.click(`a[href="/-/workspaces"]`);
        yield* page.until(`!!document.querySelector('[data-console-workspace="Shop team"]')`);

        // What is wrong with a name is said with the buttons where they were.
        yield* page.click("[data-console-workspace-new]");
        yield* page.until(`!!document.querySelector("[data-console-name-dialog] input")`);
        const naming = [yield* placed(page)];
        // One field is asked for in the window's middle.
        expect(yield* stands(page)).toBe("middle");
        yield* page.key("Enter", "Enter", ENTER);
        yield* page.until(
          `!!document.querySelector('[data-console-name-dialog] [data-slot="field-error"]')`,
        );
        naming.push(yield* placed(page));
        alike(naming);
        // It holds one field and is as tall as that: no taller, and with nothing to scroll to.
        expect(yield* snug(page)).toEqual({ scrolls: false, room: 0 });
        yield* closed(page);
        // A workspace's members come and go under the way to add one, which stays where it is.
        yield* choose(page, `[data-console-workspace="Shop team"] button`, "Members");
        const adding = `[data-console-member-add] button[type="submit"]`;
        const members = (count: number) =>
          page.until(
            `document.querySelectorAll('[data-console-members] [role="listitem"]').length === ${count}`,
          );
        yield* page.until(`!!document.querySelector("[data-console-member-add] input")`);
        const admitting = [yield* placed(page, adding)];
        yield* members(1);
        admitting.push(yield* placed(page, adding));
        yield* page.click(adding);
        yield* page.until(
          `!!document.querySelector('[data-console-member-add] [data-slot="field-error"]')`,
        );
        admitting.push(yield* placed(page, adding));
        // Whoever is no admin names a person by the whole address they sign in with.
        const control = yield* Control.Control;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const error = `document.querySelector('[data-console-member-add] [data-slot="field-error"]')?.textContent`;
        const address = `document.querySelector("[data-console-member-add] input")`;
        const typed = (text: string) =>
          Effect.gen(function* () {
            yield* page.click("[data-console-member-add] input");
            yield* page.type(text);
            yield* page.until(`${address}.value.endsWith(${JSON.stringify(text)})`);
          });
        yield* typed("bo@");
        yield* page.key("Enter", "Enter", ENTER);
        yield* page.until(`${error} === "Enter an email address."`);
        yield* typed("members.test");
        yield* page.key("Enter", "Enter", ENTER);
        yield* page.until(`${error} === "Nobody signs in with this address."`);
        admitting.push(yield* placed(page, adding));
        const admitted: Array<string> = [];
        for (const [at, name] of ["Bo", "Cy", "Di", "Ed", "Flo", "Gus"].entries()) {
          const email = `${name.toLowerCase()}@members.test`;
          admitted.push((yield* bootstrap.accounts.create({ payload: { name, email } })).id);
          // Bo's address is in the field already, and is somebody's now.
          if (at > 0) {
            yield* typed(email);
          }
          yield* page.key("Enter", "Enter", ENTER);
          yield* members(at + 2);
          yield* page.until(`${address}.value === ""`);
        }
        expect(yield* page.text("[data-console-members]")).toContain("gus@members.test");
        yield* shot(page, fs, "console-members");
        admitting.push(yield* placed(page, adding));
        alike(admitting);
        yield* closed(page);
        // The checks after this one find the people they make themselves, and no others.
        yield* Effect.forEach(admitted, (id) => bootstrap.accounts.remove({ params: { id } }));

        // A token is held to what is ticked and chosen in a dialog that is as tall for each.
        yield* toAccount(page, "tokens");
        yield* page.until(`!!document.querySelector("[data-console-token-new]")`);
        yield* page.click("[data-console-token-new]");
        yield* page.until(`!!document.querySelector("[data-console-token-create] input")`);
        const token = [yield* placed(page)];
        yield* shot(page, fs, "console-token-create-empty");
        yield* page.key("Enter", "Enter", ENTER);
        yield* page.until(
          `!!document.querySelector('[data-console-token-create] fieldset [data-slot="field-error"]')`,
        );
        token.push(yield* placed(page));
        yield* page.until(
          `document.querySelectorAll('[data-console-token-create] [data-slot="field-error"]').length === 2`,
        );
        yield* shot(page, fs, "console-token-create-full");
        // And what each scope does: it is as tall as holds the most it shows, so none of that
        // is scrolled to where the window has the room.
        yield* page.click("[data-console-scopes-explain]");
        yield* page.until(
          `document.querySelector("[data-console-scopes-explain]").getAttribute("aria-expanded") === "true"`,
        );
        token.push(yield* placed(page));
        expect(
          yield* page.evaluate(
            `(() => {
            const body = document.querySelector('${BODY}');
            return body.scrollHeight <= body.clientHeight;
          })()`,
          ),
        ).toBe(true);
        alike(token);
        yield* closed(page);

        // A window too short for the dialog has all of it: it scrolls between its header and
        // its buttons, and what it is told is wrong is brought into view.
        const short = yield* viewer.open(`${proxy.url}/-/account/tokens`, {
          width: 1280,
          height: 420,
        });
        yield* short.until(`!!document.querySelector("[data-console-token-new]")`);
        yield* short.click("[data-console-token-new]");
        yield* short.until(`!!document.querySelector("[data-console-token-create] input")`);
        const fits = `(() => {
        const box = (one) => document.querySelector(one).getBoundingClientRect();
        const body = document.querySelector('${BODY}');
        const [dialog, buttons] = [box('${DIALOG}'), box('${BUTTONS}')];
        return {
          within: dialog.top >= 0 && dialog.bottom <= innerHeight && Math.abs(buttons.bottom - dialog.bottom) <= 1,
          scrolls: body.scrollHeight > body.clientHeight,
        };
      })()`;
        const cramped = [yield* placed(short)];
        expect(yield* short.evaluate(fits)).toEqual({ within: true, scrolls: true });
        yield* shot(short, fs, "console-token-create-short");
        yield* short.key("Enter", "Enter", ENTER);
        yield* short.until(
          `!!document.querySelector('[data-console-token-create] fieldset [data-slot="field-error"]')`,
        );
        expect(
          yield* short.evaluate(
            `(() => {
            const said = document.querySelector('[data-console-token-create] fieldset [data-slot="field-error"]').getBoundingClientRect();
            const body = document.querySelector('${BODY}').getBoundingClientRect();
            // To within a pixel: what is scrolled to is placed between pixels.
            return said.top >= body.top - 1 && said.bottom <= body.bottom + 1;
          })()`,
          ),
        ).toBe(true);
        cramped.push(yield* placed(short));
        alike(cramped);
        expect(yield* short.evaluate(fits)).toEqual({ within: true, scrolls: true });
        expect(short.errors()).toEqual([]);
        yield* short.close;
        expect(page.errors()).toEqual([]);
      }),
    // Longer than a check gets where the machine is busy with something else.
    LONG,
  );

  it.effect("the console is installed as an app whose title bars stand for the window's", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const id = path.split("/").at(-1) ?? "";
      const card = `[data-console-session="${id}"]`;
      const page = yield* viewer.open(`${proxy.url}/-/sessions`);
      yield* page.until(`!!document.querySelector(${JSON.stringify(card)})`);

      // What a browser installs it by is served as what it is.
      const served = yield* page.evaluate(
        `(async () => {
          const type = async (path) => {
            const answer = await fetch(path, { cache: "no-store" });
            return answer.status + " " + (answer.headers.get("content-type") ?? "").split(";")[0];
          };
          const manifest = await (await fetch(document.querySelector('link[rel="manifest"]').href)).json();
          return {
            manifest: await type("/manifest.webmanifest"),
            worker: await type("/sw.js"),
            name: manifest.name,
            display: manifest.display_override,
            icons: await Promise.all(manifest.icons.map((icon) => type(icon.src).then((served) => served + " " + icon.purpose))),
          };
        })()`,
      );
      expect(served).toEqual({
        manifest: "200 application/manifest+json",
        worker: "200 text/javascript",
        name: "Aperture",
        display: ["window-controls-overlay", "standalone"],
        icons: [
          "200 image/png any",
          "200 image/png any",
          "200 image/png maskable",
          "200 image/svg+xml any",
        ],
      });

      // The worker takes the page, which loads again through it: its files are kept, and
      // nothing that is asked of the control plane or of a node is.
      yield* page.until(
        `navigator.serviceWorker.controller?.scriptURL === location.origin + "/sw.js"`,
        "30 seconds",
      );
      yield* page.evaluate(`void location.reload()`);
      yield* page.until(
        `!!navigator.serviceWorker.controller && !!document.querySelector(${JSON.stringify(card)})`,
        "30 seconds",
      );
      const entry = yield* page.evaluate(
        `document.querySelector('script[type="module"][src]').src`,
        Schema.String,
      );
      const kept = () =>
        page.evaluate(
          `(async () => {
            const kept = [];
            for (const name of await caches.keys()) {
              for (const request of await (await caches.open(name)).keys()) {
                kept.push(new URL(request.url).pathname);
              }
            }
            return kept;
          })()`,
          Schema.Array(Schema.String),
        );
      yield* until(
        "the worker keeping the page and its script",
        kept().pipe(
          Effect.map(
            (paths) => paths.includes("/index.html") && paths.includes(new URL(entry).pathname),
          ),
        ),
      );
      // What changes behind the page is seen by it at once, the worker being no part of it.
      yield* ada.api.sessions.describe({
        params: { id },
        payload: { label: "Checkout flow", tags: { team: "shop", seen: "fresh" } },
      });
      yield* page.until(`!!document.querySelector('${card} [data-console-tag="seen=fresh"]')`);
      expect(
        (yield* kept()).filter((one) => one !== "/index.html" && !one.startsWith("/assets/")),
      ).toEqual([]);
      // The browser does not so much as ask the worker about what is the control plane's.
      yield* page.evaluate(
        `void fetch("/api/control/sessions?unkept").then((answer) => answer.text())`,
      );
      const asked = `performance.getEntriesByType("resource").filter((entry) => entry.name.endsWith("?unkept")).map((entry) => entry.workerMatchedSourceType + " " + entry.workerFinalSourceType)`;
      yield* page.until(`${asked}.length === 1`);
      expect(yield* page.evaluate(asked)).toEqual(["network network"]);

      // In a tab the title bars are as they were, and nothing is there to move a window by.
      const bars = `(() => {
        const style = (selector) => {
          const element = document.querySelector(selector);
          return element === null ? null : getComputedStyle(element);
        };
        return {
          height: style("[data-app-titlebar]")?.height,
          moves: style("[data-app-titlebar]")?.getPropertyValue("app-region"),
          sidebar: style("[data-app-sidebar-titlebar]")?.height,
        };
      })()`;
      expect(yield* page.evaluate(bars)).toEqual({
        height: "48px",
        moves: "none",
        sidebar: "40px",
      });

      // The overlay itself is not to be had in this browser: its geometry is given to the
      // styles as the browser would give it, with a box where the window's buttons would be.
      const overlay = (side: "left" | "right", buttons: number, height: number) =>
        `void (() => {
          document.getElementById("wco-emulation")?.remove();
          const style = document.createElement("style");
          style.id = "wco-emulation";
          style.textContent = \`
            html.wco {
              --app-titlebar-area-x: ${side === "left" ? buttons : 0}px;
              --app-titlebar-area-width: calc(100vw - ${buttons}px);
              --app-titlebar-area-height: ${height}px;
            }
            html.wco::after {
              content: "window buttons";
              position: fixed;
              top: 0;
              ${side}: 0;
              z-index: 2147483647;
              box-sizing: border-box;
              width: ${buttons}px;
              height: ${height}px;
              border: 1px dashed #e11d48;
              background: var(--sidebar);
              color: #e11d48;
              font: 10px/${height - 2}px sans-serif;
              text-align: center;
              pointer-events: none;
            }\`;
          document.head.append(style);
          document.documentElement.classList.remove("wco-left", "wco-right");
          document.documentElement.classList.add("wco", "wco-${side}");
        })()`;
      /** Whether what is pressed in a title bar is clear of the window's buttons, and not what moves the window. */
      const clear = (bar: string, side: "left" | "right", buttons: number) =>
        `(() => {
          const bar = document.querySelector(${JSON.stringify(bar)});
          const pressed = [...bar.querySelectorAll("a, button, input, [data-browser-tab]")].filter((one) => one.getBoundingClientRect().width > 1 && one.getAttribute("aria-hidden") !== "true");
          return {
            height: bar.getBoundingClientRect().height,
            moves: getComputedStyle(bar).getPropertyValue("app-region"),
            pressed: pressed.length > 0,
            under: pressed
              .filter((one) => {
                const at = one.getBoundingClientRect();
                return ${side === "left" ? `at.left < ${buttons}` : `at.right > innerWidth - ${buttons}`};
              })
              .map((one) => one.tagName + " " + Math.round(one.getBoundingClientRect().left) + " " + one.textContent.trim()),
            held: pressed.every((one) => getComputedStyle(one).getPropertyValue("app-region") === "no-drag"),
          };
        })()`;
      const stands = { height: 38, moves: "drag", pressed: true, under: [], held: true };
      const settled = rested(page);

      // Buttons on the right, as Windows and Linux have them.
      yield* page.evaluate(overlay("right", 138, 33));
      yield* settled;
      expect(yield* page.evaluate(clear("[data-app-titlebar]", "right", 138))).toEqual(stands);
      yield* shot(page, fs, "console-wco-right");
      // The colour the browser paints behind the buttons follows the theme that was chosen.
      yield* page.evaluate(DARK);
      yield* page.until(
        `[...document.querySelectorAll('meta[name="theme-color"]')].every((meta) => meta.content === getComputedStyle(document.documentElement).getPropertyValue("--sidebar").trim())`,
      );
      yield* page.evaluate(AUTO);

      // Buttons on the left, as macOS has them: the sidebar's head is under them.
      yield* page.evaluate(overlay("left", 86, 28));
      yield* settled;
      expect(yield* page.evaluate(clear("[data-app-sidebar-titlebar]", "left", 86))).toEqual({
        ...stands,
        pressed: false,
      });
      expect(
        yield* page.evaluate(
          `document.querySelector("[data-sidebar-logo]").getBoundingClientRect().left >= 86`,
        ),
      ).toBe(true);
      yield* shot(page, fs, "console-wco-left");
      // Narrowed to its icons the sidebar is narrower than the buttons: its mark goes below
      // them, and the title bar starts after them.
      yield* page.click("[data-app-titlebar] [data-slot='sidebar-trigger']");
      yield* page.until(
        `!!document.querySelector('[data-slot="sidebar"][data-collapsible="icon"]')`,
      );
      yield* settled;
      yield* shot(page, fs, "console-wco-left-icons");
      expect(yield* page.evaluate(clear("[data-app-titlebar]", "left", 86))).toEqual(stands);
      expect(
        yield* page.evaluate(
          `document.querySelector("[data-sidebar-logo]").getBoundingClientRect().top >= 28`,
        ),
      ).toBe(true);
      yield* page.click("[data-app-titlebar] [data-slot='sidebar-trigger']");
      yield* page.until(`!!document.querySelector('[data-slot="sidebar"][data-state="expanded"]')`);
      // The cards move while the sidebar widens, and are pressed once they rest.
      yield* settled;

      // The workbench brings its own title bar, which takes the window's place the same way.
      yield* page.click(`${card} [data-console-session-open]`);
      yield* page.until(`location.pathname === ${JSON.stringify(`/-/sessions/${id}`)}`);
      yield* page.until(
        `[...document.querySelectorAll("[data-aperture-surface]")].some((surface) => surface.getBoundingClientRect().width > 0)`,
        "30 seconds",
      );
      yield* page.until(`!document.querySelector("[data-console-session-note]")`, "30 seconds");
      yield* settled;
      expect(yield* page.evaluate(clear("[data-workbench-titlebar]", "left", 86))).toEqual(stands);
      yield* shot(page, fs, "console-wco-left-session");
      yield* page.evaluate(overlay("right", 138, 33));
      yield* settled;
      expect(yield* page.evaluate(clear("[data-workbench-titlebar]", "right", 138))).toEqual(
        stands,
      );
      yield* shot(page, fs, "console-wco-right-session");
      // The sidebar comes over the workbench from the edge, its head a title bar as well.
      yield* page.mouse("mouseMoved", 400, 300);
      yield* page.hover(EDGE);
      yield* page.until(`!!document.querySelector('[data-slot="sidebar-container"][data-peek]')`);
      yield* settled;
      yield* shot(page, fs, "console-wco-right-session-sidebar");
      yield* page.mouse("mouseMoved", 600, 300);

      // Where nothing has a title bar, a bar of the window's stands above what is asked.
      const bare = yield* viewer.open(`${proxy.url}/invite`);
      yield* bare.until(`!!document.querySelector("[data-app-window-titlebar]")`);
      expect(
        yield* bare.evaluate(
          `getComputedStyle(document.querySelector("[data-app-window-titlebar]")).display`,
        ),
      ).toBe("none");
      yield* bare.evaluate(overlay("right", 138, 33));
      yield* rested(bare);
      expect(
        yield* bare.evaluate(
          `(() => {
            const bar = document.querySelector("[data-app-window-titlebar]");
            const below = document.querySelector("main form").getBoundingClientRect();
            return { height: bar.getBoundingClientRect().height, moves: getComputedStyle(bar).getPropertyValue("app-region"), below: below.top >= 38 };
          })()`,
        ),
      ).toEqual({ height: 38, moves: "drag", below: true });
      yield* shot(bare, fs, "console-wco-right-bare");
      yield* bare.close;

      // A build that was deployed since the page loaded is told of, with a way to it.
      yield* page.evaluate(
        `void (() => {
          const asked = window.fetch;
          window.fetch = (input, init) =>
            input === "/"
              ? Promise.resolve(new Response('<script type="module" crossorigin src="/assets/index-another.js"></script>', { headers: { "content-type": "text/html" } }))
              : asked(input, init);
          document.dispatchEvent(new Event("visibilitychange"));
        })()`,
      );
      yield* page.until(
        `[...document.querySelectorAll("[data-sonner-toast]")].some((toast) => toast.textContent.includes("new version") && toast.querySelector("[data-button]")?.textContent === "Reload")`,
      );
      yield* settled;
      yield* shot(page, fs, "console-new-version");
      expect(page.errors()).toEqual([]);
      yield* page.close;
    }),
  );
});
