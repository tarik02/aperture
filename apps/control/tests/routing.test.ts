import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { request } from "@aperture-browser/e2e/src/http.ts";
import * as Mcp from "@aperture-browser/e2e/src/mcp.ts";
import { directory, logsDirectory } from "@aperture-browser/e2e/src/process.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import * as Dex from "./src/dex.ts";
import { signedIn } from "./src/person.ts";
import * as Proxy from "./src/proxy.ts";
import { totp } from "./src/totp.ts";

const ENTER = 13;
const ESCAPE = 27;

const Shot = Schema.Struct({ data: Schema.String });

/** Keeps what a page shows, where the checks' logs are asked for: for whoever wants to look. */
const shot = (page: Viewer.Page, fs: FileSystem.FileSystem, name: string) =>
  Effect.gen(function* () {
    const logs = yield* logsDirectory;
    if (logs === undefined) {
      return;
    }
    const taken = yield* page.cdp.call("Page.captureScreenshot", { format: "png" });
    const { data } = yield* Schema.decodeUnknownEffect(Shot)(taken);
    yield* fs.writeFile(`${logs}/${name}.png`, yield* Effect.fromResult(Base64.decode(data)));
  }).pipe(Effect.ignore);

/**
 * Has a page note where it was when the workbench first said that a session starts: the
 * session is opened before there is one, at an address that is not yet its own.
 */
const noteStarting = (page: Viewer.Page) =>
  page.evaluate(
    `void (window.startedAt = undefined, new MutationObserver(() => {
      if (window.startedAt === undefined && document.querySelector('[data-console-session-note="asked"]')) {
        window.startedAt = location.pathname;
      }
    }).observe(document.body, { childList: true, subtree: true }))`,
  );

/** Waits for a session that was asked for to have its own address, which took the place of the first. */
const started = (page: Viewer.Page) =>
  Effect.gen(function* () {
    yield* page.until(
      `location.pathname.startsWith("/-/sessions/") && !location.pathname.startsWith("/-/sessions/new-")`,
      "30 seconds",
    );
    expect(yield* page.evaluate("window.startedAt", Schema.String)).toMatch(
      /^\/-\/sessions\/new-/u,
    );
    return yield* page.evaluate(`location.pathname.split("/").at(-1)`, Schema.String);
  });

/**
 * Chooses a theme at once. The fade into it never ends in a page nobody looks at, which
 * takes no clicks while it fades, so the checks' pages have none.
 */
const theme = (label: string) =>
  `(document.startViewTransition = undefined, void document.querySelector('[role="radio"][aria-label="${label}"]').click())`;
/** Presses what a list that opened offers, by what it says. */
const choose = (page: Viewer.Page, items: string, says: string) =>
  Effect.gen(function* () {
    const found = `[...document.querySelectorAll(${JSON.stringify(items)})].find((one) => one.textContent.includes(${JSON.stringify(says)}))`;
    yield* page.until(`!!${found}`);
    yield* page.evaluate(
      `void (${found}.scrollIntoView({ block: "nearest" }), ${found}.setAttribute("data-chosen-by-checks", ""))`,
    );
    yield* page.click("[data-chosen-by-checks]");
    yield* page.evaluate(
      `void document.querySelector("[data-chosen-by-checks]")?.removeAttribute("data-chosen-by-checks")`,
    );
  });

/**
 * Names the token the dialog that is open makes, and makes it. The dialog grows into its
 * place while it opens, and a click meant for a field of it lands beside the field until it
 * is there: so it is waited for, and what is typed is seen in the field before it is sent.
 */
const nameToken = (page: Viewer.Page, name: string) =>
  Effect.gen(function* () {
    const field = `document.querySelector('[data-console-token-create] input[name="name"]')`;
    yield* page.until(
      `${field}?.closest('[data-slot="dialog-content"]').getAnimations().length === 0`,
    );
    yield* page.click(`[data-console-token-create] input[name="name"]`);
    yield* page.until(`document.activeElement === ${field}`);
    yield* page.type(name);
    yield* page.until(`${field}.value === ${JSON.stringify(name)}`);
    yield* page.key("Enter", "Enter", ENTER);
  });

const DARK = theme("Dark");
const AUTO = theme("Auto");

/** Keeps what a page shows in the dark as well. */
const shotDark = (page: Viewer.Page, fs: FileSystem.FileSystem, name: string) =>
  Effect.gen(function* () {
    yield* page.evaluate(DARK);
    yield* shot(page, fs, name);
    yield* page.evaluate(AUTO);
  });

/** Chooses among what a select offers. */
const pick = (page: Viewer.Page, trigger: string, says: string) =>
  Effect.gen(function* () {
    yield* page.evaluate(
      `void document.querySelector(${JSON.stringify(trigger)}).scrollIntoView({ block: "nearest" })`,
    );
    // What it stands in may still be settling into place, and a press beside it opens
    // nothing: it is pressed again until its list is there.
    yield* page
      .click(trigger)
      .pipe(
        Effect.andThen(
          page.until(`!!document.querySelector('[data-slot="select-item"]')`, "2 seconds"),
        ),
        Effect.retry({ times: 5 }),
      );
    // A list that opened under the pointer takes no press of it for a moment.
    yield* Effect.sleep("600 millis");
    yield* choose(page, `[data-slot="select-item"]`, says);
    yield* page.until(
      `document.querySelector(${JSON.stringify(trigger)}).textContent.includes(${JSON.stringify(says)}) && !document.querySelector('[data-slot="select-content"][data-open]')`,
    );
  });

const DIALOG = `[data-slot="dialog-content"]`;
const BODY = `${DIALOG} [data-slot="dialog-body"] [data-slot="scroll-area-viewport"]`;
const BUTTONS = `${DIALOG} [data-slot="dialog-footer"]`;

/**
 * Where the open dialog is, and its buttons or what else is to stay put in it, once it has
 * come to rest. A dialog keeps its height whatever it holds, so its states are placed alike.
 */
const placed = (page: Viewer.Page, part = BUTTONS) =>
  Effect.gen(function* () {
    yield* page.until(
      `document.querySelector('${DIALOG}')?.getAnimations().every((one) => one.playState === "finished")`,
    );
    const dialog = yield* page.box(DIALOG);
    const kept = yield* page.box(part);
    return { top: dialog.top, height: dialog.height, part: [kept.left, kept.top, kept.height] };
  });

const alike = (states: ReadonlyArray<unknown>) =>
  expect(states).toEqual(states.map(() => states[0]));

/** Opens what a session's menu offers, by what it says. */
const fromMenu = (page: Viewer.Page, card: string, says: string) =>
  Effect.gen(function* () {
    yield* page.click(`${card} [aria-label="Session actions"]`);
    yield* choose(page, `[data-slot="dropdown-menu-item"]`, says);
    yield* page.until(`!!document.querySelector('${DIALOG}')`);
  });

const closed = (page: Viewer.Page) =>
  Effect.gen(function* () {
    yield* page.key("Escape", "Escape", ESCAPE);
    yield* page.until(`!document.querySelector('${DIALOG}')`);
  });

/** A node that registers itself, and takes the tickets the control plane signs. */
const node = Layer.effect(
  Executor.Executor,
  Effect.gen(function* () {
    const control = yield* Control.Control;
    const fs = yield* FileSystem.FileSystem;
    const bootstrap = yield* control.as(control.bootstrapToken);
    const token = yield* bootstrap.nodes.createRegistrationToken({ payload: { name: "checks" } });
    const file = `${yield* directory}/registration-token`;
    yield* fs.writeFileString(file, token.token);
    return yield* Executor.start({
      features: ["mcp", "cdp", "uploads", "downloads", "recordings", "clipboard", "sound"],
      env: {
        APERTURE_TICKET_KEY: control.ticketKey,
        APERTURE_CONTROL_PLANE: control.url,
        APERTURE_REGISTRATION_TOKEN_FILE: file,
        APERTURE_NODE: "node-behind-the-proxy",
      },
    });
  }),
);

// The provider after the proxy: people come back from it to the proxy's address.
const needs = Dex.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Proxy.layer, Viewer.layer)),
  Layer.provideMerge(node),
  Layer.provideMerge(Control.layer({ stores: "memory", console: true, sso: {} })),
  Layer.provideMerge(Dex.address),
);

suite(needs)("sessions behind a proxy that asks the control plane", (it) => {
  let ada: Effect.Success<ReturnType<typeof Control.account>>;
  let path = "";

  it.effect("a session is reached at its path through the proxy, by its owner alone", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const executor = yield* Executor.Executor;
      ada = yield* Control.account("Ada");
      const created = yield* until(
        "a session on the node that registered",
        ada.api.sessions.create({ payload: {} }),
        "30 seconds",
      );
      expect(created.path).toBe(`/n/${created.nodeId}/sessions/${created.id}`);
      path = created.path ?? "";

      const targets = `${path}/targets`;
      // The proxy learns of the node when it next asks for its routes.
      const answer = yield* until(
        "the proxy sending the request on to the node",
        request(proxy.url, ada.token, "GET", targets).pipe(
          Effect.map((answered) => answered.status === 200 && answered),
        ),
        "30 seconds",
      );
      expect(answer.body).toEqual((yield* executor.session(created.id, "GET", "/targets")).body);

      // What is not a person comes the same way: automation, with the account's token.
      const agent = yield* Mcp.connect(`${proxy.url}${path}`, ada.token);
      expect((yield* agent.tools).length).toBeGreaterThan(0);

      expect((yield* request(proxy.url, "", "GET", targets)).status).toBe(401);
      expect((yield* request(proxy.url, "apc_not-a-token", "GET", targets)).status).toBe(401);
      const eve = yield* Control.account("Eve");
      expect((yield* request(proxy.url, eve.token, "GET", targets)).status).toBe(404);
      // The node's own token is not the proxy's to take: what lets one in is the account's.
      expect((yield* request(proxy.url, executor.token, "GET", targets)).status).toBe(401);
    }),
  );

  it.effect("the control plane's API is reached through the proxy as well", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const answer = yield* request(proxy.url, ada.token, "GET", "/api/control/sessions");
      expect(answer.status).toBe(200);
    }),
  );

  it.effect("a browser that was given the cookie opens the session there, socket and all", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const viewer = yield* Viewer.Viewer;
      const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
      const kept = yield* until(
        "the page being there to ask for the cookie",
        page.evaluate(
          `fetch("/api/control/route/cookie", { method: "POST", headers: { Authorization: "Bearer ${ada.token}" } }).then((answer) => answer.status)`,
          Schema.Number,
        ),
      );
      expect(kept).toBe(204);
      // A page cannot read it, and so cannot give it away.
      expect(yield* page.evaluate("document.cookie", Schema.String)).toBe("");

      yield* page.evaluate(`void (location.href = ${JSON.stringify(`${path}/?fit=0`)})`);
      yield* Viewer.ready(page);
      // The node knows who came by the ticket the proxy put on the socket's request.
      const me = yield* page.evaluate(
        `(() => {
          const { presence } = apertureSession.getSnapshot();
          return presence.members.find((member) => member.id === presence.you)?.name ?? "";
        })()`,
        Schema.String,
      );
      expect(me).toBe("Ada");
    }),
  );

  it.effect("the console signs in with a token, lists the session and opens it", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const page = yield* viewer.open(`${proxy.url}/`);
      yield* page.until(`!!document.querySelector("[data-console-sign-in-way]")`);
      yield* page.click("[data-console-sign-in-way]");
      yield* page.until(`!!document.querySelector('[data-console-sign-in="token"] input')`);
      yield* page.click("[data-console-sign-in] input");
      yield* page.type(ada.token);
      yield* page.key("Enter", "Enter", ENTER);

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
      yield* page.evaluate(DARK);
      yield* shot(page, fs, "console-sessions-dark");
      yield* page.evaluate(AUTO);

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
      yield* page.evaluate(DARK);
      yield* shot(page, fs, "console-bulk-dark");
      yield* page.evaluate(AUTO);
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
        (name) => ada.api.accounts.createOwnToken({ payload: { name, scopes: ["sessions:read"] } }),
        { concurrency: 8 },
      );
      yield* page.click(`a[href="/-/tokens"]`);
      yield* page.until(`!!document.querySelector('[data-console-token="checks"]')`);
      yield* page.click("[data-console-token-new]");
      yield* page.until(`!!document.querySelector("[data-console-token-create] input")`);
      // A token with no name is not asked for: the field says what it lacks.
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(
        `!!document.querySelector('[data-console-token-create] [data-slot="field-error"]')`,
      );
      // Nor one that does nothing: a scope is ticked, and the token is held to it.
      expect(yield* page.text("[data-console-token-create]")).toContain("Tick at least one scope");
      yield* shot(page, fs, "console-token-create-invalid");
      yield* page.click(`[data-console-scope="sessions:read"]`);
      yield* page.until(
        `document.querySelector('[data-console-scope="sessions:read"]').hasAttribute("data-checked")`,
      );
      // It reaches all the account does, or only what is chosen: here the one session.
      yield* page.click(`[data-console-token-reach] [data-slot="select-trigger"]`);
      yield* page.until(`document.querySelectorAll('[data-slot="select-item"]').length === 2`);
      // A list that opened under the pointer takes no press of it for a moment.
      yield* Effect.sleep("600 millis");
      yield* page.click(`[data-slot="select-item"]:last-child`);
      yield* page.until(`!!document.querySelector("[data-console-token-resources] input")`);
      yield* page.click("[data-console-token-resources] input");
      yield* page.type("Checkout");
      const resource = `[data-console-token-resource="sessions:${id}"]`;
      yield* page.until(`!!document.querySelector('${resource}')`);
      yield* page.click(resource);
      yield* page.until(
        `!!document.querySelector('[data-console-token-resource-chosen="sessions:${id}"]')`,
      );
      yield* shot(page, fs, "console-token-resources");
      yield* page.click(`[data-console-token-create] input[name="name"]`);
      yield* page.type("from the console");
      yield* shot(page, fs, "console-token-create");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector("[data-console-secret]")`);
      const secret = (yield* page.text("[data-console-secret]")) ?? "";
      expect(secret).toMatch(/^apc_/u);
      const withIt = yield* (yield* Control.Control).as(secret);
      expect((yield* withIt.accounts.current()).id).toBe(ada.account.id);
      expect((yield* withIt.sessions.list()).map((session) => session.id)).toEqual([id]);
      expect((yield* Effect.flip(withIt.snapshots.list()))._tag).toBe("Forbidden");
      const held = (yield* ada.api.accounts.tokens()).find(
        (token) => token.name === "from the console",
      );
      expect([held?.scopes, held?.resources]).toEqual([
        ["sessions:read"],
        { workspaces: [], sessions: [id], snapshots: [] },
      ]);
      yield* shot(page, fs, "console-token");
      yield* page.key("Escape", "Escape", ESCAPE);
      // What it shows stays while it closes, and the table tells what the token is held to.
      yield* page.until(`!document.querySelector("[data-console-secret]")`);
      const row = `[data-console-token="from the console"]`;
      yield* page.until(
        `!!document.querySelector('${row} [data-console-token-scope="sessions:read"]')`,
      );
      expect(yield* page.text(`${row} [data-console-token-resource="sessions"]`)).toBe("1 session");
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
              above: shell.dataset.canScrollTop,
              within: shell.getBoundingClientRect().bottom <= innerHeight,
            }))));
          })()`,
        ),
      ).toEqual({ scrolled: 200, pinned: true, above: "true", within: true });
      yield* shot(page, fs, "console-tokens");
      yield* page.evaluate(DARK);
      yield* shot(page, fs, "console-tokens-dark");
      yield* page.evaluate(AUTO);

      // How an MCP client reaches every session is told from the sidebar: by signing in.
      yield* page.click("[data-console-mcp-open]");
      yield* page.until(`!!document.querySelector('[data-console-mcp-auth="oauth"] code')`);
      const signingIn = (yield* page.text("[data-console-mcp]")) ?? "";
      expect(signingIn).toContain(`claude mcp add --transport http aperture '${proxy.url}/mcp'`);
      expect(signingIn).not.toContain("Bearer");
      yield* shot(page, fs, "console-mcp");
      yield* page.evaluate(DARK);
      yield* shot(page, fs, "console-mcp-dark");
      yield* page.evaluate(AUTO);
      // Each client is told its own way.
      yield* page.click(`[data-console-mcp-client="cursor"]`);
      yield* page.until(
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
      const [replaced] = yield* ada.api.snapshots.list();
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
      const kept = yield* ada.api.snapshots.list();
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
      // The sidebar is out of the way there, and comes when the pointer rests at the edge.
      // The edge is felt once the workbench has laid itself out, so it is come to again.
      yield* Effect.gen(function* () {
        yield* page.mouse("mouseMoved", 400, 300);
        yield* page.mouse("mouseMoved", 2, 300);
        yield* page.until(
          `!!document.querySelector('[data-slot="sidebar-container"][data-peek]')`,
          "3 seconds",
        );
      }).pipe(Effect.retry({ times: 5 }));
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
      // The pointer comes to the edge again where its first coming was too early to be seen.
      yield* until(
        "the sidebar of a small window",
        small
          .mouse("mouseMoved", 300, 200)
          .pipe(
            Effect.andThen(small.mouse("mouseMoved", 2, 200)),
            Effect.andThen(Effect.sleep("400 millis")),
            Effect.andThen(small.evaluate(sheet)),
          ),
      );
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
      yield* shotDark(page, fs, "console-session-browser-menu-dark");
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
      yield* page.evaluate(DARK);
      yield* shot(page, fs, "console-sidebar-dark");
      yield* page.evaluate(AUTO);

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
      expect(yield* page.text("[data-console-workspace-switcher]")).toContain("Shop team");
      yield* page.until(`!document.querySelector("[data-console-name-dialog]")`);
      yield* shot(page, fs, "console-workspaces");
      yield* page.click(`a[href="/-/sessions"]`);
      yield* page.until(`!!document.querySelector("[data-console-empty]")`);
      expect(page.errors()).toEqual([]);
    }),
  );

  it.effect("a dialog keeps its height and its buttons their place, whatever it shows", () =>
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

      // What is known of the session is in tabs of one dialog, which is as tall for each.
      const tabs = `${DIALOG} [data-slot="tabs-list"]`;
      yield* fromMenu(page, card, "Details");
      const details = [yield* placed(page, tabs)];
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

      // Its routing is asked for and then edited in a dialog that is as tall all along.
      yield* fromMenu(page, card, "Edit routing");
      const routed = [yield* placed(page)];
      const proxied = "[data-console-session-proxy] [data-console-proxy]";
      const routing = `${DIALOG} [data-console-proxy] > [data-slot="select-trigger"]`;
      yield* page.until(`!!document.querySelector('${proxied}')`);
      yield* shot(page, fs, "console-routing");
      routed.push(yield* placed(page));
      yield* pick(page, routing, "one proxy");
      yield* page.until(`!!document.querySelector('${DIALOG} input[name="proxy-url"]')`);
      routed.push(yield* placed(page));
      yield* page.click(`${DIALOG} button[type="submit"]`);
      yield* page.until(`!!document.querySelector('${proxied} [data-slot="field-error"]')`);
      yield* shot(page, fs, "console-routing-proxy-invalid");
      routed.push(yield* placed(page));
      yield* pick(page, routing, "By rules");
      for (const says of ["Upstream", "Upstream", "Rule", "Rule", "Rule"]) {
        yield* choose(page, `${proxied} button`, says);
      }
      yield* page.until(`document.querySelectorAll('[aria-label="Rule match"]').length === 3`);
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
      yield* shot(page, fs, `console-save-snapshot-${other}`);
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
      // were, whatever tab and routing it shows.
      yield* page.click("[data-console-create-custom]");
      const create = "[data-console-session-create]";
      yield* page.until(`!!document.querySelector("${create} input")`);
      yield* page.click(`${create} input`);
      yield* page.type("Made in a dialog");
      yield* shot(page, fs, "console-create-general");
      yield* shotDark(page, fs, "console-create-general-dark");
      const creating = [yield* placed(page)];
      const tab = (at: number) => page.click(`${DIALOG} [role="tab"]:nth-of-type(${at})`);
      yield* tab(2);
      yield* page.until(`!!document.querySelector("${create} [data-console-proxy]")`);
      yield* shot(page, fs, "console-create-routing");
      yield* shotDark(page, fs, "console-create-routing-dark");
      creating.push(yield* placed(page));
      yield* pick(page, routing, "one proxy");
      yield* page.until(`!!document.querySelector('${create} input[name="proxy-url"]')`);
      yield* shot(page, fs, "console-create-routing-proxy");
      creating.push(yield* placed(page));
      yield* pick(page, routing, "By rules");
      for (const says of ["Upstream", "Upstream", "Rule", "Rule", "Rule"]) {
        yield* choose(page, `${create} [data-console-proxy] button`, says);
      }
      yield* page.until(`document.querySelectorAll('[aria-label="Rule match"]').length === 3`);
      yield* shot(page, fs, "console-create-rules");
      yield* shotDark(page, fs, "console-create-rules-dark");
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
      yield* shot(page, fs, "console-create-rules-invalid");
      creating.push(yield* placed(page));
      yield* pick(page, routing, "Direct");
      yield* tab(3);
      yield* page.until(`!!document.querySelector('[aria-label="Add tag"]')`);
      creating.push(yield* placed(page));
      // A press right after the tab changes is not always taken.
      yield* Effect.sleep("600 millis");
      for (const rows of [1, 2, 3, 4]) {
        yield* page.click(`[aria-label="Add tag"]`);
        yield* page.until(
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
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(
        `!!document.querySelector('[data-console-name-dialog] [data-slot="field-error"]')`,
      );
      yield* shot(page, fs, "console-name-invalid");
      naming.push(yield* placed(page));
      alike(naming);
      yield* closed(page);
      // A workspace's members come and go under the way to add one, which stays where it is.
      yield* choose(page, `[data-console-workspace="Shop team"] button`, "Members");
      const adding = `[data-console-member-add] button[type="submit"]`;
      const members = (count: number) =>
        page.until(`document.querySelectorAll("[data-console-members] li").length === ${count}`);
      yield* page.until(`!!document.querySelector("[data-console-member-add] input")`);
      const admitting = [yield* placed(page, adding)];
      yield* members(1);
      admitting.push(yield* placed(page, adding));
      yield* page.click(adding);
      yield* page.until(
        `!!document.querySelector('[data-console-member-add] [data-slot="field-error"]')`,
      );
      yield* shot(page, fs, "console-members-invalid");
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
      yield* page.until(`${error} === "Enter an email address"`);
      yield* typed("members.test");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`${error} === "Nobody signs in with this address"`);
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
      yield* shotDark(page, fs, "console-members-dark");
      admitting.push(yield* placed(page, adding));
      alike(admitting);
      yield* closed(page);
      // The checks after this one find the people they make themselves, and no others.
      yield* Effect.forEach(admitted, (id) => bootstrap.accounts.remove({ params: { id } }));

      // A token is held to what is ticked and chosen in a dialog that is as tall for each.
      yield* page.click(`a[href="/-/tokens"]`);
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
      yield* pick(page, `[data-console-token-reach] [data-slot="select-trigger"]`, "Only chosen");
      yield* page.until(`!!document.querySelector("[data-console-token-resources] input")`);
      token.push(yield* placed(page));
      // Nothing chosen is told as well: the dialog then says all it ever does.
      yield* page.click(`${DIALOG} button[type="submit"]`);
      yield* page.until(
        `document.querySelectorAll('[data-console-token-create] [data-slot="field-error"]').length === 3`,
      );
      yield* shot(page, fs, "console-token-create-full");
      yield* shotDark(page, fs, "console-token-create-full-dark");
      token.push(yield* placed(page));
      alike(token);
      yield* closed(page);

      // A window too short for the dialog has all of it: it scrolls between its header and
      // its buttons, and what it is told is wrong is brought into view.
      const short = yield* viewer.open(`${proxy.url}/-/tokens`, {
        width: 1280,
        height: 560,
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
      yield* shot(short, fs, "console-token-create-short-invalid");
      cramped.push(yield* placed(short));
      alike(cramped);
      expect(yield* short.evaluate(fits)).toEqual({ within: true, scrolls: true });
      expect(short.errors()).toEqual([]);
      yield* short.close;
      expect(page.errors()).toEqual([]);
    }),
  );

  it.effect(
    "on a phone the menu closes when it leads elsewhere, a table and a dialog fit, and a finger scrolls the session",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const id = path.split("/").at(-1) ?? "";
        const page = yield* viewer.open(`${proxy.url}/-/tokens`, {
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
        yield* page
          .click(`[data-slot="sidebar-trigger"]`)
          .pipe(
            Effect.andThen(page.until(`!!document.querySelector('${drawer}')`, "2 seconds")),
            Effect.retry({ times: 5 }),
          );
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
        const stage = yield* page.box("[data-aperture-stage]");
        const finger = (type: string, y?: number) =>
          page.cdp.call("Input.dispatchTouchEvent", {
            type,
            touchPoints: y === undefined ? [] : [{ x: stage.x, y }],
          });
        // The picture may still be on its way when the page says it is there: the finger
        // is drawn over it again until the page has moved.
        yield* Effect.gen(function* () {
          yield* finger("touchStart", stage.y + 200);
          for (let moved = 20; moved <= 300; moved += 20) {
            yield* finger("touchMove", stage.y + 200 - moved);
            yield* Effect.sleep("16 millis");
          }
          yield* finger("touchEnd");
          yield* page.until(`${title} !== "tall"`, "3 seconds");
        }).pipe(Effect.retry({ times: 5 }));
        expect(yield* page.evaluate(title, Schema.String)).toBe("scrolled");
        yield* shot(page, fs, "console-phone-workbench");
        expect(page.errors()).toEqual([]);
        yield* page.close;
      }),
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
      const settled = Effect.sleep("400 millis");

      // Buttons on the right, as Windows and Linux have them.
      yield* page.evaluate(overlay("right", 138, 33));
      yield* settled;
      expect(yield* page.evaluate(clear("[data-app-titlebar]", "right", 138))).toEqual(stands);
      yield* shot(page, fs, "console-wco-right");
      yield* shotDark(page, fs, "console-wco-right-dark");
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
      yield* shotDark(page, fs, "console-wco-left-dark");
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
      yield* shotDark(page, fs, "console-wco-right-session-dark");
      // The sidebar comes over the workbench from the edge, its head a title bar as well.
      yield* Effect.gen(function* () {
        yield* page.mouse("mouseMoved", 400, 300);
        yield* page.mouse("mouseMoved", 2, 300);
        yield* page.until(
          `!!document.querySelector('[data-slot="sidebar-container"][data-peek]')`,
          "3 seconds",
        );
      }).pipe(Effect.retry({ times: 5 }));
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
      yield* settled;
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

  it.effect("a person follows a setup link, signs in, and opens a session with cookies alone", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const control = yield* Control.Control;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const email = "mira@example.test";
      const password = "a password of Mira's own";
      const mira = yield* bootstrap.accounts.create({ payload: { name: "Mira", email } });
      const { token } = yield* bootstrap.accounts.createSetupToken({ params: { id: mira.id } });

      const page = yield* viewer.open(`${proxy.url}/invite#token=${encodeURIComponent(token)}`);
      yield* page.until(`!!document.querySelector("[data-console-invite] input")`);
      // The browser is the one the check before signed in with: nothing of that is left.
      yield* page.evaluate(
        `(localStorage.clear(), fetch("/api/control/route/cookie", { method: "DELETE" }).then((answer) => answer.status))`,
      );
      yield* page.evaluate("void location.reload()");
      yield* page.until(
        `localStorage.length === 0 && !!document.querySelector("[data-console-invite] input")`,
      );
      yield* page.click("[data-console-invite] input");
      yield* page.type(password);
      yield* page.key("Enter", "Enter", ENTER);

      // The way in, since setting a password signs nobody in.
      yield* page.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
      yield* page.click(`[data-console-sign-in] input[name="email"]`);
      yield* page.type(email);
      yield* page.click(`[data-console-sign-in] input[name="password"]`);
      yield* page.type(password);
      yield* shot(page, fs, "console-sign-in");
      yield* page.key("Enter", "Enter", ENTER);

      yield* page.until(`!!document.querySelector("[data-console-create]")`);
      yield* noteStarting(page);
      yield* page.click("[data-console-create]");
      yield* started(page);
      // The session's socket went through the proxy with the cookies of whoever signed in.
      yield* page.until(
        `[...document.querySelectorAll("[data-aperture-surface]")].some((surface) => surface.getBoundingClientRect().width > 0)`,
        "60 seconds",
      );
      // Who is there is told a moment after the picture is.
      yield* Viewer.ready(page);
      const me = yield* page.evaluate(
        `(() => {
          const { presence } = apertureSession.getSnapshot();
          return presence.members.find((member) => member.id === presence.you)?.name ?? "";
        })()`,
        Schema.String,
      );
      expect(me).toBe("Mira");
      expect(page.errors()).toEqual([]);
    }),
  );

  it.effect("a person turns a second factor on in the console, and signs in with a code", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const control = yield* Control.Control;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const email = "noor@example.test";
      const password = "a password of Noor's own";
      const noor = yield* bootstrap.accounts.create({ payload: { name: "Noor", email } });
      const { token } = yield* bootstrap.accounts.createSetupToken({ params: { id: noor.id } });

      const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
      const asked = (path: string, body: object) =>
        page.evaluate(
          `fetch(${JSON.stringify(`/api/auth${path}`)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then((answer) => answer.status)`,
          Schema.Number,
        );
      const signIn = Effect.gen(function* () {
        yield* page.evaluate(`void (location.href = "/")`);
        yield* page.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
        yield* page.click(`[data-console-sign-in] input[name="email"]`);
        yield* page.type(email);
        yield* page.click(`[data-console-sign-in] input[name="password"]`);
        yield* page.type(password);
        yield* page.key("Enter", "Enter", ENTER);
      });
      // The browser is the one the check before signed in with: its person is signed out first.
      expect(yield* until("the page being there to sign out from", asked("/sign-out", {}))).toBe(
        200,
      );
      expect(yield* asked("/reset-password", { token, newPassword: password })).toBe(200);
      yield* signIn;

      yield* page.until(`!!document.querySelector("[data-console-security]")`);
      yield* page.click("[data-console-security]");
      const dialog = (step: string) => `[data-console-security-dialog="${step}"]`;
      yield* page.until(`!!document.querySelector('${dialog("none")} input')`);
      // Each step has a height of its own, which nothing within the step changes; the
      // dialog moves from one to the next, and is measured once it is there.
      const still = page.until(
        `document.querySelector('[data-slot="dialog-content"]').getAnimations().length === 0`,
      );
      const first = [yield* placed(page)];
      yield* page.click(`${dialog("none")} input`);
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${dialog("none")} [data-slot="field-error"]')`);
      yield* shot(page, fs, "console-security-invalid");
      first.push(yield* placed(page));
      alike(first);
      yield* page.type(password);
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${dialog("confirm")} input')`);
      // The address as a picture, for an authenticator's camera.
      yield* page.until(
        `(document.querySelector("[data-console-totp-qr] path")?.getAttribute("d")?.length ?? 0) > 100`,
      );
      yield* still;
      yield* shot(page, fs, "console-totp");
      yield* shotDark(page, fs, "console-totp-dark");
      const second = [yield* placed(page)];
      // And as text in the picture's place, for whoever cannot scan it.
      yield* page.click("[data-console-totp-manual]");
      yield* page.until(`!!document.querySelector("[data-console-totp-uri] code")`);
      const uri = (yield* page.text("[data-console-totp-uri] code")) ?? "";
      yield* shot(page, fs, "console-totp-manual");
      second.push(yield* placed(page));
      alike(second);
      expect(uri).toMatch(/^otpauth:\/\/totp\/Aperture:/u);
      yield* page.click(`${dialog("confirm")} input`);
      // The whole code gives itself: nothing is left to press.
      yield* page.type(yield* totp(uri));
      yield* page.until(`!!document.querySelector('${dialog("backup-codes")}')`);
      expect(yield* page.text("[data-console-backup-codes] code")).toMatch(/\w{5}-\w{5}/u);
      yield* still;
      yield* shot(page, fs, "console-backup-codes");

      // The password alone leads to the code, and nowhere further.
      expect(yield* asked("/sign-out", {})).toBe(200);
      yield* signIn;
      yield* page.until(`!!document.querySelector('[data-console-sign-in="code"] input')`);
      yield* shot(page, fs, "console-sign-in-code");
      yield* page.click("[data-console-sign-in] input");
      // The whole code gives itself: nothing is left to press.
      yield* page.type(yield* totp(uri));
      yield* page.until(`!!document.querySelector("[data-console-security]")`);
      expect(page.errors()).toEqual([]);
    }),
  );

  it.effect("a person adds a passkey in the console, and signs in with it and nothing else", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const control = yield* Control.Control;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const email = "pia@example.test";
      const password = "a password of Pia's own";
      const pia = yield* bootstrap.accounts.create({ payload: { name: "Pia", email } });
      const { token } = yield* bootstrap.accounts.createSetupToken({ params: { id: pia.id } });

      // A passkey is of a name and never of an address in numbers: the proxy by its name,
      // where the browser has nothing of the checks before.
      const base = proxy.url.replace("127.0.0.1", "localhost");
      const page = yield* viewer.open(`${base}/api/control/openapi.json`);
      // An authenticator of the browser's own, which makes and shows passkeys once it is
      // told that someone is there. It is told for what the person does themselves, and
      // not before: the page that signs in asks for a passkey where the address is typed
      // as soon as it is there, and an authenticator that answers that by itself signs
      // the person in again before they are seen to be out.
      yield* page.cdp.call("WebAuthn.enable", {});
      const { authenticatorId } = yield* page.cdp.call(
        "WebAuthn.addVirtualAuthenticator",
        {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: false,
          },
        },
        Schema.Struct({ authenticatorId: Schema.String }),
      );
      const present = (enabled: boolean) =>
        page.cdp.call("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled });
      const asked = <A>(path: string, body: object, answer: Schema.Codec<A>) =>
        page.evaluate(
          `fetch(${JSON.stringify(`/api/auth${path}`)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async (answer) => ({ ...(await answer.json().catch(() => ({}))), status: answer.status }))`,
          answer,
        );
      const Status = Schema.Struct({ status: Schema.Number });
      const signOut = Effect.gen(function* () {
        yield* present(false);
        expect((yield* asked("/sign-out", {}, Status)).status).toBe(200);
        yield* page.evaluate(`void (location.href = "/")`);
        yield* page.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
      });
      /**
       * Presses the button with someone there for what it asks. What the page asked for
       * where the address is typed was asked of an authenticator with nobody there, and
       * stays unanswered until the button calls it off.
       */
      const withPasskey = Effect.gen(function* () {
        yield* page.until(
          `performance.getEntriesByType("resource").some((one) => one.name.endsWith("/passkey/generate-authenticate-options"))`,
        );
        yield* present(true);
        yield* page.click("[data-console-sign-in-passkey]");
      });
      expect(
        (yield* until(
          "the page being there to set a password from",
          asked("/reset-password", { token, newPassword: password }, Status),
        )).status,
      ).toBe(200);
      yield* page.evaluate(`void (location.href = "/")`);
      yield* page.until(`!!document.querySelector("[data-console-sign-in-passkey]")`);
      yield* shot(page, fs, "console-sign-in-passkey");
      // Nothing chooses a theme before anyone is signed in: the page follows the browser.
      const scheme = (value: string) =>
        page.cdp.call("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value }],
        });
      yield* scheme("dark");
      yield* shot(page, fs, "console-sign-in-passkey-dark");
      yield* scheme("");
      // What is wrong with what was typed is said on a line that was kept for it: nothing
      // below a field moves from under the pointer.
      const signs = `[data-console-sign-in] button[type="submit"]`;
      const rested = yield* page.box(signs);
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(
        `document.querySelectorAll('[data-console-sign-in] [data-slot="field-error"]').length === 2`,
      );
      expect(yield* page.box(signs)).toEqual(rested);
      yield* shot(page, fs, "console-sign-in-invalid");
      yield* page.click(`[data-console-sign-in] input[name="email"]`);
      yield* page.type(email);
      yield* page.click(`[data-console-sign-in] input[name="password"]`);
      yield* page.type(password);
      yield* page.key("Enter", "Enter", ENTER);

      // The passkeys are beside the second factor, in a dialog that keeps its height.
      const dialog = (step: string) => `[data-console-security-dialog="${step}"]`;
      const passkey = (name: string) => `[data-console-passkey="${name}"]`;
      const open = Effect.gen(function* () {
        yield* page.until(`!!document.querySelector("[data-console-security]")`);
        yield* page.click("[data-console-security]");
        yield* page.until(`!!document.querySelector('${dialog("none")} input')`);
        const first = yield* placed(page);
        yield* page.click(`[data-console-security-tab="passkeys"]`);
        yield* page.until(`!!document.querySelector('${dialog("passkeys")}')`);
        return first;
      });
      const add = (name: string) =>
        Effect.gen(function* () {
          yield* page.click("[data-console-passkey-add]");
          yield* page.until(
            `document.activeElement === document.querySelector('${dialog("passkey-name")} input')`,
          );
          yield* page.type(name);
          yield* page.until(
            `document.querySelector('${dialog("passkey-name")} input').value === ${JSON.stringify(name)}`,
          );
        });
      const states = [yield* open];
      yield* present(true);
      yield* page.until(`!!document.querySelector('${dialog("passkeys")} [data-console-empty]')`);
      states.push(yield* placed(page));
      yield* shot(page, fs, "console-passkeys-none");
      // One is not added without a name.
      yield* page.click("[data-console-passkey-add]");
      yield* page.until(`!!document.querySelector('${dialog("passkey-name")} input')`);
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(
        `!!document.querySelector('${dialog("passkey-name")} [data-slot="field-error"]')`,
      );
      states.push(yield* placed(page));
      yield* page.click(`${dialog("passkey-name")} input`);
      yield* page.type("Laptop");
      yield* shot(page, fs, "console-passkey-name");
      yield* shotDark(page, fs, "console-passkey-name-dark");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${passkey("Laptop")}')`);
      states.push(yield* placed(page));

      // It is named anew.
      yield* page.click(`${passkey("Laptop")} [data-console-passkey-rename]`);
      yield* page.until(
        `document.activeElement === document.querySelector('${dialog("passkey-name")} input')`,
      );
      yield* page.type(" of Pia");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${passkey("Laptop of Pia")}')`);
      yield* shot(page, fs, "console-passkeys");
      yield* shotDark(page, fs, "console-passkeys-dark");
      states.push(yield* placed(page));
      alike(states);

      // With a second factor on, the passkey still signs in by itself: no code is asked.
      const { totpURI } = yield* asked(
        "/two-factor/enable",
        { password },
        Schema.Struct({ totpURI: Schema.String }),
      );
      expect(
        (yield* asked("/two-factor/verify-totp", { code: yield* totp(totpURI) }, Status)).status,
      ).toBe(200);
      yield* signOut;
      // Nobody is signed in by what the page asks for unasked.
      yield* Effect.sleep("1 second");
      expect(
        yield* page.evaluate(`!!document.querySelector('[data-console-sign-in="password"]')`),
      ).toBe(true);
      yield* withPasskey;
      yield* open;
      yield* page.until(`!!document.querySelector('${passkey("Laptop of Pia")}')`);

      // It is removed, once that is said again.
      yield* page.click(`${passkey("Laptop of Pia")} [data-console-passkey-remove]`);
      yield* page.until(`!!document.querySelector('${dialog("passkey-remove")}')`);
      yield* shot(page, fs, "console-passkey-remove");
      yield* page.click("[data-console-passkey-remove-confirm]");
      yield* page.until(`!!document.querySelector('${dialog("passkeys")} [data-console-empty]')`);

      // An admin removes a person's passkeys without them, and none of them signs in after.
      yield* page.cdp.call("WebAuthn.clearCredentials", { authenticatorId });
      yield* add("Phone");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${passkey("Phone")}')`);
      yield* bootstrap.accounts.removePasskeys({ params: { id: pia.id } });
      yield* signOut;
      yield* withPasskey;
      yield* page.until(`!!document.querySelector('[data-console-sign-in] [role="alert"]')`);
      expect(yield* page.text(`[data-console-sign-in] [role="alert"]`)).toBe(
        "That passkey is none of an account here.",
      );
      yield* shot(page, fs, "console-sign-in-passkey-refused");
      yield* page.cdp.call("WebAuthn.disable", {});
      expect(page.errors()).toEqual([]);
    }),
  );

  it.effect("an admin keeps people and service accounts apart, each on a page of its own", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const control = yield* Control.Control;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* Control.account("Root", true);

      const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
      // The browser is the one the check before signed in with: nothing of that is left.
      yield* until(
        "the page being there to sign out from",
        page.evaluate(
          `(localStorage.clear(), Promise.all([fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), fetch("/api/control/route/cookie", { method: "DELETE" })]).then(() => true))`,
          Schema.Boolean,
        ),
      );
      yield* page.evaluate(`void (location.href = "/")`);
      yield* page.until(`!!document.querySelector("[data-console-sign-in-way]")`);
      yield* page.click("[data-console-sign-in-way]");
      yield* page.until(`!!document.querySelector('[data-console-sign-in="token"] input')`);
      yield* page.click("[data-console-sign-in] input");
      yield* page.type(root.token);
      yield* page.key("Enter", "Enter", ENTER);

      // A person is made with a name and an address, and not without either.
      yield* page.until(`!!document.querySelector('a[href="/-/people"]')`);
      yield* page.click(`a[href="/-/people"]`);
      yield* page.until(`!!document.querySelector("[data-console-person-new]")`);
      yield* page.click("[data-console-person-new]");
      const person = "[data-console-person-create]";
      yield* page.until(`!!document.querySelector('${person} input[name="name"]')`);
      const inviting = [yield* placed(page)];
      yield* page.click(`${person} input[name="name"]`);
      yield* page.type("Lin");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${person} [data-slot="field-error"]')`);
      inviting.push(yield* placed(page));
      alike(inviting);
      yield* shot(page, fs, "console-person-create");
      yield* page.evaluate(DARK);
      yield* shot(page, fs, "console-person-create-dark");
      yield* page.evaluate(AUTO);
      expect((yield* root.api.accounts.list()).filter((account) => account.name === "Lin")).toEqual(
        [],
      );
      yield* page.click(`${person} input[name="email"]`);
      yield* page.type("lin@example.test");
      yield* page.key("Enter", "Enter", ENTER);
      const lin = `[data-console-person="Lin"]`;
      yield* page.until(`!!document.querySelector('${lin}')`);
      // The dialog is in the way of the row until it has closed.
      yield* page.until(`!document.querySelector('${person}')`);
      // People are told apart from what is not a person, and no token is made for them here.
      expect(yield* page.evaluate(`!!document.querySelector("[data-console-service]")`)).toBe(
        false,
      );
      expect(yield* page.text(lin)).not.toContain("API token");
      yield* page.click(`${lin} [data-console-setup-link]`);
      yield* page.until(`!!document.querySelector("[data-console-secret]")`);
      expect(yield* page.text("[data-console-secret]")).toContain("/invite#token=");
      yield* page.key("Escape", "Escape", ESCAPE);
      yield* page.until(`!document.querySelector("[data-console-secret]")`);
      yield* page.hover(`${lin} [data-console-setup-link]`);
      yield* shot(page, fs, "console-people");

      // What a person signs in with is told beside them: nothing, until they set a password.
      expect(yield* page.text(lin)).toContain("Nothing yet");
      const { token } = yield* root.api.accounts.createSetupToken({
        params: {
          id: (yield* root.api.accounts.list()).find((one) => one.name === "Lin")?.id ?? "",
        },
      });
      yield* page.evaluate(
        `fetch("/api/auth/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ token, newPassword: "a password of Lin's own" }))} }).then((answer) => answer.status)`,
        Schema.Number,
      );
      const does = (says: string) =>
        Effect.gen(function* () {
          yield* page.click(`${lin} [data-console-person-actions]`);
          yield* choose(page, `[data-slot="dropdown-menu-item"]`, says);
        });
      const confirmed = Effect.gen(function* () {
        yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
        yield* placed(page);
        yield* page.click(`${BUTTONS} button:last-child`);
        yield* page.until(`!document.querySelector('${DIALOG}')`);
      });
      // Disabled, a person stays where they were, and is put in use again as they were.
      yield* does("Disable");
      yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
      yield* placed(page);
      yield* shot(page, fs, "console-person-disable");
      yield* confirmed;
      yield* page.until(`!!document.querySelector('${lin}[data-console-person-state="disabled"]')`);
      yield* page.until(
        `!!document.querySelector('${lin} [data-console-sign-in-method="password"]')`,
      );
      yield* page.click(`${lin} [data-console-person-actions]`);
      yield* page.until(`!!document.querySelector('[data-slot="dropdown-menu-item"]')`);
      yield* shot(page, fs, "console-people-disabled");
      yield* shotDark(page, fs, "console-people-disabled-dark");
      yield* choose(page, `[data-slot="dropdown-menu-item"]`, "Enable");
      yield* page.until(`!!document.querySelector('${lin}[data-console-person-state="in-use"]')`);
      // The same is offered where the row is clicked with the other button.
      yield* page.click(`${lin} td`, "right");
      yield* page.until(`!!document.querySelector("[data-console-person-context]")`);
      expect(yield* page.text("[data-console-person-context]")).toContain("Remove passkeys");
      yield* page.key("Escape", "Escape", ESCAPE);
      yield* page.until(`!document.querySelector("[data-console-person-context]")`);
      // Deleted, they are gone.
      yield* does("Delete");
      yield* confirmed;
      yield* page.until(`!document.querySelector('${lin}')`);
      expect((yield* root.api.accounts.list()).filter((account) => account.name === "Lin")).toEqual(
        [],
      );

      // A service account is made with a name, and comes with tokens that are held to scopes.
      yield* page.click(`a[href="/-/service-accounts"]`);
      yield* page.until(`!!document.querySelector("[data-console-service-new]")`);
      yield* page.click("[data-console-service-new]");
      yield* page.until(`!!document.querySelector("[data-console-name-dialog] input")`);
      yield* page.click("[data-console-name-dialog] input");
      yield* page.type("Deploy bot");
      yield* shot(page, fs, "console-name");
      yield* page.key("Enter", "Enter", ENTER);
      const bot = `[data-console-service="Deploy bot"]`;
      yield* page.until(`!!document.querySelector('${bot}')`);
      yield* page.until(`!document.querySelector("[data-console-name-dialog]")`);
      expect(yield* page.evaluate(`!!document.querySelector("[data-console-person]")`)).toBe(false);
      yield* shot(page, fs, "console-service-accounts");
      // Its tokens have a page of their own, reached from its row: none yet.
      const botId =
        (yield* root.api.accounts.list()).find((one) => one.name === "Deploy bot")?.id ?? "";
      const spareToken = yield* root.api.accounts.createToken({
        params: { id: botId },
        payload: { name: "spare", scopes: ["sessions:read"] },
      });
      yield* page.click(`${bot} [data-console-service-tokens]`);
      yield* page.until(`location.pathname === "/-/service-accounts/${botId}/tokens"`);
      yield* page.until(
        `document.querySelector("[data-console-crumb]")?.textContent === "Deploy bot"`,
      );
      yield* page.until(`!!document.querySelector('[data-console-token="spare"]')`);
      expect(yield* page.evaluate(`!!document.querySelector("[data-console-service]")`)).toBe(
        false,
      );
      yield* page.click("[data-console-token-new]");
      yield* page.until(`!!document.querySelector("[data-console-token-create] input")`);
      expect(yield* page.text(DIALOG)).toContain("Deploy bot");
      yield* page.click(`[data-console-scope="sessions:write"]`);
      yield* page.until(
        `document.querySelector('[data-console-scope="sessions:write"]').hasAttribute("data-checked")`,
      );
      yield* shot(page, fs, "console-service-token");
      yield* nameToken(page, "deploys");
      yield* page.until(`!!document.querySelector("[data-console-secret]")`);
      const withIt = yield* control.as((yield* page.text("[data-console-secret]")) ?? "");
      const whose = yield* withIt.accounts.current();
      expect([whose.name, whose.kind]).toEqual(["Deploy bot", "service"]);
      yield* withIt.sessions.list();
      expect((yield* Effect.flip(withIt.snapshots.list()))._tag).toBe("Forbidden");
      yield* page.key("Escape", "Escape", ESCAPE);
      yield* page.until(`!document.querySelector("[data-console-secret]")`);
      const deploys = `[data-console-token="deploys"]`;
      yield* page.until(`!!document.querySelector('${deploys}')`);
      yield* shot(page, fs, "console-service-tokens");
      yield* shotDark(page, fs, "console-service-tokens-dark");
      // One is taken back from its row, once that is said again, and the other stays good.
      const spared = `[data-console-token="spare"]`;
      const asSpare = yield* control.as(spareToken.token);
      expect((yield* asSpare.accounts.current()).name).toBe("Deploy bot");
      yield* page.click(`${spared} [data-console-row-action="revoke"]`);
      yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
      yield* placed(page);
      yield* shot(page, fs, "console-service-token-revoke");
      yield* page.click(`${BUTTONS} button:last-child`);
      yield* page.until(`!document.querySelector('${DIALOG}')`);
      yield* page.until(`!document.querySelector('${spared}')`);
      expect((yield* Effect.flip(asSpare.accounts.current()))._tag).toBe("Unauthorized");
      expect((yield* withIt.accounts.current()).name).toBe("Deploy bot");
      yield* pick(page, `[aria-label="Which tokens"]`, "Revoked or expired");
      yield* page.until(`document.querySelector('${spared}')?.textContent.includes("revoked")`);
      expect(yield* page.evaluate(`!!document.querySelector('${deploys}')`)).toBe(false);
      expect(yield* page.evaluate(`!!document.querySelector('${spared} button')`)).toBe(false);
      yield* pick(page, `[aria-label="Which tokens"]`, "Active");
      // A right click on a row offers what its button does.
      yield* page.click(`${deploys} td`, "right");
      yield* page.until(
        `[...document.querySelectorAll('[data-slot="context-menu-item"]')].some((item) => item.textContent.includes("Revoke"))`,
      );
      yield* page.key("Escape", "Escape", ESCAPE);
      yield* page.until(`!document.querySelector('[data-slot="context-menu-item"]')`);
      // On a phone a token is a block of its own, with what is done with it in its menu.
      const narrow = yield* viewer.open(`${proxy.url}/-/service-accounts/${botId}/tokens`, {
        width: 390,
        height: 844,
        mobile: true,
      });
      yield* narrow.until(`!!document.querySelector('${deploys}')`);
      yield* narrow.click(`${deploys} [aria-label="Token actions"]`);
      yield* narrow.until(`!!document.querySelector('[data-slot="dropdown-menu-item"]')`);
      yield* shot(narrow, fs, "console-phone-service-tokens");
      yield* shotDark(narrow, fs, "console-phone-service-tokens-dark");
      expect(yield* narrow.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
        true,
      );
      yield* narrow.close;
      // The title bar leads back to the accounts.
      yield* page.click("[data-console-crumb-back]");
      yield* page.until(`!!document.querySelector('${bot}')`);
      // It is kept out and removed as a person is: disabled, its token is nobody's.
      const doesToBot = (says: string) =>
        Effect.gen(function* () {
          yield* page.click(`${bot} [data-console-person-actions]`);
          yield* choose(page, `[data-slot="dropdown-menu-item"]`, says);
        });
      yield* doesToBot("Disable");
      yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
      yield* placed(page);
      yield* shot(page, fs, "console-service-disable");
      yield* confirmed;
      yield* page.until(
        `!!document.querySelector('${bot}[data-console-service-state="disabled"]')`,
      );
      expect((yield* Effect.flip(withIt.accounts.current()))._tag).toBe("Unauthorized");
      yield* page.click(`${bot} td`, "right");
      yield* page.until(`!!document.querySelector("[data-console-person-context]")`);
      expect(yield* page.text("[data-console-person-context]")).toContain("API tokens");
      yield* shot(page, fs, "console-service-accounts-disabled");
      yield* shotDark(page, fs, "console-service-accounts-disabled-dark");
      yield* choose(page, `[data-slot="context-menu-item"]`, "Enable");
      yield* page.until(`!!document.querySelector('${bot}[data-console-service-state="in-use"]')`);
      expect((yield* withIt.accounts.current()).name).toBe("Deploy bot");
      yield* doesToBot("Delete");
      yield* confirmed;
      yield* page.until(`!document.querySelector('${bot}')`);

      // What lets nodes register is kept apart from the nodes.
      yield* root.api.nodes.createRegistrationToken({ payload: { name: "spare" } });
      yield* page.click(`a[href="/-/registration-tokens"]`);
      yield* page.until(`!!document.querySelector('[data-console-registration-token="checks"]')`);
      expect(yield* page.evaluate(`!!document.querySelector("[data-console-node]")`)).toBe(false);
      yield* shot(page, fs, "console-registration-tokens");
      // One is taken back from its row's menu, once that is said again, and is kept among
      // those that were.
      const spare = `[data-console-registration-token="spare"]`;
      const which = `[aria-label="Which tokens"]`;
      yield* page.click(`${spare} [aria-label="Token actions"]`);
      yield* choose(page, `[data-slot="dropdown-menu-item"]`, "Revoke");
      yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
      yield* placed(page);
      yield* shot(page, fs, "console-registration-token-revoke");
      yield* confirmed;
      yield* page.until(`!document.querySelector('${spare}')`);
      yield* pick(page, which, "Revoked");
      yield* page.until(`document.querySelector('${spare}')?.textContent.includes("revoked")`);
      expect(
        yield* page.evaluate(
          `!!document.querySelector('[data-console-registration-token="checks"]')`,
        ),
      ).toBe(false);
      // Nothing is left to do with it.
      expect(yield* page.evaluate(`!!document.querySelector('${spare} button')`)).toBe(false);
      yield* shot(page, fs, "console-registration-tokens-revoked");
      yield* shotDark(page, fs, "console-registration-tokens-revoked-dark");
      // A right click on a row offers what its menu does.
      yield* pick(page, which, "Active");
      const row = yield* page.box(`[data-console-registration-token="checks"]`);
      yield* page.clickAt(row.x, row.y, "right");
      yield* page.until(
        `[...document.querySelectorAll('[data-slot="context-menu-item"]')].some((item) => item.textContent.includes("Revoke"))`,
      );
      yield* shot(page, fs, "console-registration-token-context");
      yield* page.key("Escape", "Escape", ESCAPE);
      yield* page.until(`!document.querySelector('[data-slot="context-menu-item"]')`);
      // On a phone a token is a block of its own, with what is done with it in its menu.
      const phone = yield* viewer.open(`${proxy.url}/-/registration-tokens`, {
        width: 390,
        height: 844,
        mobile: true,
      });
      yield* phone.until(`!!document.querySelector('[data-console-registration-token="checks"]')`);
      yield* phone.click(`[data-console-registration-token="checks"] [aria-label="Token actions"]`);
      yield* phone.until(`!!document.querySelector('[data-slot="dropdown-menu-item"]')`);
      yield* shot(phone, fs, "console-phone-registration-tokens");
      expect(yield* phone.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
        true,
      );
      yield* phone.close;
      yield* page.click(`a[href="/-/nodes"]`);
      yield* page.until(`!!document.querySelector("[data-console-node]")`);
      expect(
        yield* page.evaluate(`!!document.querySelector("[data-console-registration-token]")`),
      ).toBe(false);
      yield* shot(page, fs, "console-nodes");
      expect(page.errors()).toEqual([]);
    }),
  );

  it.effect(
    "an admin reads what was done on the page of events, by its kind and by who did it",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const auditor = yield* Control.account("Auditor", true);
        const quill = yield* Control.account("Quill");
        // More than a page of events, one about what is still there and one about what is gone.
        yield* Effect.forEach(
          Array.from({ length: 52 }, (_, at) => `token ${at}`),
          (name) =>
            auditor.api.accounts.createOwnToken({ payload: { name, scopes: ["events:read"] } }),
          { discard: true },
        );
        yield* quill.api.workspaces.create({ payload: { name: "Kept workspace" } });
        const gone = yield* auditor.api.workspaces.create({ payload: { name: "Gone workspace" } });
        yield* auditor.api.workspaces.delete({ params: { id: gone.id } });

        const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
        // The browser is the one the check before signed in with: nothing of that is left.
        yield* until(
          "the page being there to sign out from",
          page.evaluate(
            `(localStorage.clear(), Promise.all([fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), fetch("/api/control/route/cookie", { method: "DELETE" })]).then(() => true))`,
            Schema.Boolean,
          ),
        );
        yield* page.evaluate(`void (location.href = "/")`);
        yield* page.until(`!!document.querySelector("[data-console-sign-in-way]")`);
        yield* page.click("[data-console-sign-in-way]");
        yield* page.until(`!!document.querySelector('[data-console-sign-in="token"] input')`);
        yield* page.click("[data-console-sign-in] input");
        yield* page.type(auditor.token);
        yield* page.key("Enter", "Enter", ENTER);

        yield* page.until(`!!document.querySelector('a[href="/-/events"]')`);
        yield* page.click(`a[href="/-/events"]`);
        const rows = `[...document.querySelectorAll("[data-console-event]")]`;
        const count = page.evaluate(`${rows}.length`, Schema.Number);
        // The newest first, a page of them, and the ones before when they are asked for.
        yield* page.until(`${rows}.length === 50`);
        expect(
          yield* page.evaluate(`${rows}[0].getAttribute("data-console-event")`, Schema.String),
        ).toBe("workspace.deleted");
        expect(yield* page.text(`[data-console-event] [data-console-event-says]`)).toBe(
          "Deleted the workspace",
        );
        yield* shot(page, fs, "console-events");
        yield* shotDark(page, fs, "console-events-dark");
        yield* page.evaluate(
          `void document.querySelector("[data-console-events-more]").scrollIntoView({ block: "nearest" })`,
        );
        yield* page.click("[data-console-events-more]");
        yield* page.until(`${rows}.length > 50`);
        expect(yield* count).toBeGreaterThan(54);

        // What an event is about leads to it while it is there, and only names it once it is gone.
        const about = (name: string) =>
          page.evaluate(
            `${rows}.filter((row) => row.textContent.includes(${JSON.stringify(name)})).map((row) => row.querySelector("[data-console-event-link]")?.getAttribute("href") ?? null)`,
            Schema.Array(Schema.NullOr(Schema.String)),
          );
        expect(yield* about("Kept workspace")).toEqual(["/-/workspaces"]);
        expect(yield* about("Gone workspace")).toEqual([null, null]);

        // By its kind, chosen from a list of all there are.
        yield* pick(page, `[aria-label="Kind of event"]`, "Workspace deleted");
        yield* page.until(
          `${rows}.length === 1 && ${rows}[0].getAttribute("data-console-event") === "workspace.deleted"`,
        );
        yield* page.click(`[aria-label="Kind of event"]`);
        yield* page.until(`!!document.querySelector('[data-slot="select-item"]')`);
        yield* Effect.sleep("600 millis");
        yield* shot(page, fs, "console-events-kinds");
        yield* shotDark(page, fs, "console-events-kinds-dark");
        yield* choose(page, `[data-slot="select-item"]`, "All events");
        yield* page.until(`${rows}.length >= 50`);

        // By who did it, by a part of what they are called.
        yield* page.click("[data-console-events-actor]");
        yield* page.type("quil");
        yield* page.until(
          `${rows}.length === 1 && ${rows}[0].textContent.includes("Quill") && ${rows}[0].textContent.includes("Made the workspace")`,
        );
        yield* shot(page, fs, "console-events-actor");
        yield* page.click("[data-console-events-actor]");
        yield* page.type("-nobody-is-called-this");
        yield* page.until(`!!document.querySelector("[data-console-empty]")`);

        // On a phone an event is a block of its own, and what narrows the list is two
        // buttons in the title bar: the search opens below it, the kinds in a menu.
        const phone = yield* viewer.open(`${proxy.url}/-/events`, {
          width: 390,
          height: 844,
          mobile: true,
        });
        yield* phone.until(`${rows}.length === 50`);
        yield* shot(phone, fs, "console-phone-events");
        const scheme = (value: string) =>
          phone.cdp.call("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value }],
          });
        yield* scheme("dark");
        yield* shot(phone, fs, "console-phone-events-dark");
        yield* scheme("");
        expect(
          yield* phone.evaluate(
            `(() => {
              const table = document.querySelector('[data-slot="table-container"] [data-slot="scroll-area-viewport"]');
              const title = document.querySelector("[data-app-titlebar]");
              return {
                page: document.documentElement.scrollWidth <= innerWidth,
                table: table.scrollWidth <= table.clientWidth,
                cells: [...document.querySelectorAll('[data-slot="table-cell"]')].every((cell) => cell.getBoundingClientRect().right <= innerWidth),
                bar: [...title.querySelectorAll("button")].every((button) => { const box = button.getBoundingClientRect(); return box.width === 0 || (box.left >= 0 && box.right <= innerWidth); }),
              };
            })()`,
          ),
        ).toEqual({ page: true, table: true, cells: true, bar: true });
        yield* phone.click("[data-console-filters]");
        yield* phone.until(`!!document.querySelector('[data-slot="dropdown-menu-radio-item"]')`);
        yield* Effect.sleep("300 millis");
        yield* shot(phone, fs, "console-phone-events-kinds");
        yield* choose(phone, `[data-slot="dropdown-menu-radio-item"]`, "Workspace deleted");
        yield* phone.until(
          `${rows}.length === 1 && ${rows}[0].getAttribute("data-console-event") === "workspace.deleted"`,
        );
        yield* phone.click("[data-console-search-open]");
        yield* phone.until(
          `document.activeElement?.getAttribute("aria-label") === "Search by actor"`,
        );
        yield* phone.type("-nobody-is-called-this");
        yield* phone.until(`!!document.querySelector("[data-console-empty]")`);
        yield* shot(phone, fs, "console-phone-events-search");
        expect(phone.errors()).toEqual([]);
        yield* phone.close;

        const wide = yield* viewer.open(`${proxy.url}/-/events`, { width: 1440, height: 900 });
        yield* wide.until(`${rows}.length === 50`);
        yield* shot(wide, fs, "console-events-wide");
        yield* wide.close;
      }),
  );

  it.effect("an app sends a person to say what it gets, who signs in first and is sent back", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const sana = yield* signedIn("Sana", "sana@example.test");
      const registered = yield* request(proxy.url, "", "POST", "/oauth/register", {
        client_name: "An agent of the checks",
        redirect_uris: [`${proxy.url}/callback`],
      });
      const app = yield* Schema.decodeUnknownEffect(Schema.Struct({ client_id: Schema.String }))(
        registered.body,
      );
      const verifier = "what-the-app-keeps-to-itself-0123456789-0123456789";
      const challenge = Base64Url.encode(
        new Uint8Array(
          yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
          ),
        ),
      );
      const asked = new URLSearchParams({
        response_type: "code",
        client_id: app.client_id,
        redirect_uri: `${proxy.url}/callback`,
        state: "the app's own",
        scope: "sessions:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });

      const page = yield* viewer.open(`${proxy.url}/oauth/authorize?${asked.toString()}`);
      yield* page.until(`location.pathname === "/oauth/consent"`);
      // The browser is the one the checks before signed in with: nothing of that is left.
      yield* page.evaluate(
        `(localStorage.clear(), fetch("/api/auth/sign-out", { method: "POST" }).then((answer) => answer.status))`,
      );
      yield* page.evaluate("void location.reload()");
      yield* page.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
      yield* page.click(`[data-console-sign-in] input[name="email"]`);
      yield* page.type(sana.email);
      yield* page.click(`[data-console-sign-in] input[name="password"]`);
      yield* page.type(sana.password);
      yield* page.key("Enter", "Enter", ENTER);

      // Signed in, they are where the app sent them, and are asked what the app asked for.
      yield* page.until(`!!document.querySelector("[data-console-consent-allow]")`);
      expect(yield* page.text("[data-console-consent]")).toContain(
        "Connect An agent of the checks?",
      );
      expect(
        yield* page.evaluate(
          `[...document.querySelectorAll("[data-console-consent] [data-console-scope][data-checked]")].map((one) => one.dataset.consoleScope)`,
        ),
      ).toEqual(["sessions:read"]);
      yield* shot(page, fs, "console-consent");
      expect(page.errors()).toEqual([]);
      yield* page.click("[data-console-consent-allow]");
      yield* page.until(`location.pathname === "/callback"`);
      const back = new URLSearchParams(yield* page.evaluate("location.search", Schema.String));
      expect(back.get("state")).toBe("the app's own");

      const http = yield* HttpClient.HttpClient;
      const tokens = yield* http
        .execute(
          HttpClientRequest.post(`${proxy.url}/oauth/token`).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: "authorization_code",
              code: back.get("code") ?? "",
              client_id: app.client_id,
              redirect_uri: `${proxy.url}/callback`,
              code_verifier: verifier,
            }),
          ),
        )
        .pipe(
          Effect.flatMap((answer) => answer.json),
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Struct({ access_token: Schema.String })),
          ),
        );
      const agent = yield* Mcp.connect(proxy.url, tokens.access_token);
      yield* agent.call("sessions.list", {});
      expect((yield* Effect.flip(agent.call("sessions.create", {}))).reason).toMatch(
        /not for sessions:write/u,
      );

      // What they gave is theirs to see, and to take back.
      yield* page.evaluate(`void (location.href = "/-/connected-apps")`);
      yield* page.until(
        `!!document.querySelector('[data-console-grant="An agent of the checks"] [data-console-grant-scope="sessions:read"]')`,
      );
      yield* shot(page, fs, "console-connected-apps");
      yield* page.click(`[data-console-grant] button`);
      yield* choose(page, `[data-slot="dialog-footer"] button`, "Disconnect");
      yield* page.until(`!document.querySelector("[data-console-grant]")`);
      expect((yield* request(proxy.url, tokens.access_token, "POST", "/mcp", {})).status).toBe(401);
    }),
  );

  it.effect(
    "a person signs in through a provider from the sign-in page, and one it is none for is told",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const [ada, bob] = Dex.VERIFIED;
        yield* bootstrap.accounts.create({
          payload: { name: "Ada of the provider", email: ada.email },
        });

        const page = yield* viewer.open(`${proxy.url}/-/snapshots`);
        // The browser is the one the checks before signed in with: nothing of that is left.
        yield* page.evaluate(
          `(localStorage.clear(), Promise.all([fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), fetch("/api/control/route/cookie", { method: "DELETE" })]).then(() => true))`,
        );
        yield* page.evaluate("void location.reload()");

        /** Goes to the provider by the button, and signs in there with a password. */
        const through = (email: string) =>
          Effect.gen(function* () {
            yield* page.until(`!!document.querySelector('[data-console-sso="${Dex.PROVIDER}"]')`);
            expect(yield* page.text(`[data-console-sso="${Dex.PROVIDER}"]`)).toBe(
              `Continue with ${Dex.PROVIDER_NAME}`,
            );
            yield* page.click(`[data-console-sso="${Dex.PROVIDER}"]`);
            // The provider has more ways than one, and asks which.
            yield* page.until(`!!document.querySelector('a[href*="/dex/auth/local"]')`);
            yield* page.click(`a[href*="/dex/auth/local"]`);
            yield* page.until(`!!document.querySelector('input[name="login"]')`);
            yield* page.click(`input[name="login"]`);
            yield* page.type(email);
            yield* page.click(`input[name="password"]`);
            yield* page.type(Dex.PASSWORD);
            yield* page.key("Enter", "Enter", ENTER);
          });

        yield* through(bob.email);
        yield* page.until(`!!document.querySelector("[data-console-sso-refused]")`);
        expect(yield* page.text("[data-console-sso-refused]")).toMatch(/No account here/u);
        // They are where they were going, and why not is in the address no more.
        expect(yield* page.evaluate("location.pathname + location.search", Schema.String)).toBe(
          "/-/snapshots",
        );
        yield* shot(page, fs, "console-sign-in-provider");

        yield* through(ada.email);
        yield* page.until(
          `location.origin === ${JSON.stringify(proxy.url)} && !document.querySelector("[data-console-sign-in]") && !!document.querySelector("[data-sidebar]")`,
          "30 seconds",
        );
        expect(yield* page.evaluate("location.pathname", Schema.String)).toBe("/-/snapshots");
        expect(
          yield* page.evaluate(
            `fetch("/api/control/account").then((answer) => answer.json()).then((account) => account.email)`,
            Schema.String,
          ),
        ).toBe(ada.email);

        // Disabled, they are signed out where they are, and told why the provider's word
        // signs them in no more.
        const account = yield* bootstrap.accounts
          .list()
          .pipe(Effect.map((all) => all.find((one) => one.email === ada.email)));
        yield* bootstrap.accounts.disable({ params: { id: account?.id ?? "" } });
        yield* page.evaluate("void location.reload()");
        yield* through(ada.email);
        yield* page.until(`!!document.querySelector("[data-console-sso-refused]")`);
        expect(yield* page.text("[data-console-sso-refused]")).toBe(
          "This account is disabled. Ask an admin.",
        );
        yield* shot(page, fs, "console-sign-in-disabled");
        expect(page.errors()).toEqual([]);
      }),
  );

  it.effect(
    "the owner makes a share link, a guest with no account opens it under a name, and is out once it is revoked",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const control = yield* Control.Control;
        const bootstrap = yield* control.as(control.bootstrapToken);
        // A person, whom every page of the browser has signed in at once.
        const person = yield* signedIn("Owner of the shared", "owner-of-the-shared@example.test");
        const { token } = yield* bootstrap.accounts.createToken({
          params: { id: person.account.id },
          payload: { name: "checks", scopes: Control.ALL_SCOPES },
        });
        const owner = { api: yield* control.as(token) };
        // The node may only now have told of itself, where no check ran before this one.
        const made = yield* until(
          "a node taking the shared session",
          owner.api.sessions.create({ payload: { label: "Shared with a guest" } }),
          "30 seconds",
        );
        yield* until(
          "the shared session running",
          owner.api.sessions
            .get({ params: { id: made.id } })
            .pipe(Effect.map((session) => session.observedState === "running")),
          "60 seconds",
        );

        const page = yield* viewer.open(`${proxy.url}/-/sessions`);
        // The browser is the one the checks before signed in with: nothing of that is left.
        yield* page.evaluate(
          `(localStorage.clear(), Promise.all([fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), fetch("/api/control/route/cookie", { method: "DELETE" })]).then(() => true))`,
        );
        yield* page.evaluate("void location.reload()");
        yield* page.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
        yield* page.click(`[data-console-sign-in] input[name="email"]`);
        yield* page.type(person.email);
        yield* page.click(`[data-console-sign-in] input[name="password"]`);
        yield* page.type(person.password);
        yield* page.key("Enter", "Enter", ENTER);
        const card = `[data-console-session="${made.id}"]`;
        yield* page.until(`!!document.querySelector(${JSON.stringify(card)})`);
        yield* fromMenu(page, card, "Share");

        const name = `[data-console-share-create] input[name="name"]`;
        yield* page.until(
          `document.querySelector(${JSON.stringify(name)})?.closest('[data-slot="dialog-content"]').getAnimations().length === 0`,
        );
        const height = () =>
          page.evaluate(
            `document.querySelector(${JSON.stringify(name)}).closest('[data-slot="dialog-content"]').getBoundingClientRect().height`,
            Schema.Number,
          );
        const empty = yield* height();
        yield* page.click(name);
        yield* page.type("For the guest");
        yield* pick(
          page,
          `[data-console-share-create] [aria-label="What it lets them do"]`,
          "Control",
        );
        yield* choose(page, "[data-console-share-create] button", "New link");
        yield* page.until(`!!document.querySelector("[data-console-secret]")`);
        const link = (yield* page.text("[data-console-secret]")) ?? "";
        expect(link).toMatch(new RegExp(`^${proxy.url}/share/[0-9a-f-]+#aps_`, "u"));
        yield* shot(page, fs, "console-share-link");
        yield* choose(page, `${DIALOG} button`, "Done");
        yield* page.until(`!document.querySelector("[data-console-secret]")`);
        yield* page.until(`!!document.querySelector('[data-console-share="For the guest"]')`);
        expect(yield* page.text(`[data-console-share="For the guest"]`)).toContain("Control");
        // The dialog is as tall with a link in it as it was with none.
        expect(yield* height()).toBe(empty);
        yield* shot(page, fs, "console-share");
        yield* shotDark(page, fs, "console-share-dark");

        // A browser of the guest's own: it carries nothing of the owner's.
        const guests = yield* Viewer.start;
        const guest = yield* guests.open(link);
        yield* guest.until(`!!document.querySelector('[data-console-guest="name"] input')`);
        // The secret is in the address no more, and nothing of the console is around.
        expect(yield* guest.evaluate("location.pathname + location.hash", Schema.String)).toBe(
          new URL(link).pathname,
        );
        expect(yield* guest.evaluate(`!!document.querySelector("[data-sidebar]")`)).toBe(false);
        yield* shot(guest, fs, "console-guest-name");
        yield* guest.click(`[data-console-guest="name"] input`);
        yield* guest.type("Grace the guest");
        yield* guest.key("Enter", "Enter", ENTER);
        yield* guest.until(`!!document.querySelector('[data-console-guest="session"]')`);
        yield* Viewer.ready(guest);
        yield* guest.until(`!!document.querySelector("[data-aperture-drawn]")`, "30 seconds");
        expect(yield* guest.evaluate(`!!document.querySelector("[data-sidebar]")`)).toBe(false);
        // Shown again, the page needs no link in its address: the browser carries it.
        yield* guest.evaluate("void location.reload()");
        yield* guest.until(`!!document.querySelector('[data-console-guest="session"]')`);
        yield* Viewer.ready(guest);
        yield* guest.until(`!!document.querySelector("[data-aperture-drawn]")`, "30 seconds");
        yield* shot(guest, fs, "console-guest-session");
        // The API is none of a guest's.
        expect(
          yield* guest.evaluate(
            `fetch("/api/control/sessions").then((answer) => answer.status)`,
            Schema.Number,
          ),
        ).toBe(401);

        // The owner sees them among the members, by the name they chose.
        const opened = yield* viewer.open(`${proxy.url}/-/sessions/${made.id}`);
        yield* Viewer.ready(opened, 2);
        const members = `apertureSession.getSnapshot().presence.members.map((member) => member.name)`;
        yield* opened.until(`${members}.includes("Grace the guest")`);
        expect(yield* opened.evaluate(members, Schema.Array(Schema.String))).toEqual(
          expect.arrayContaining(["Owner of the shared", "Grace the guest"]),
        );

        // Taking a link back is asked again, as whatever is not undone is.
        yield* page.click(`[data-console-share="For the guest"] button`);
        yield* choose(page, `[data-slot="dialog-footer"] button`, "Revoke");
        yield* page.until(`!document.querySelector('[data-console-share="For the guest"]')`);
        yield* guest.until(
          `!!document.querySelector('[data-console-guest="refused"]')`,
          "30 seconds",
        );
        yield* shot(guest, fs, "console-guest-refused");
        yield* opened.until(`!${members}.includes("Grace the guest")`);
        expect(page.errors()).toEqual([]);
        yield* owner.api.sessions.delete({ params: { id: made.id } });
      }),
  );
});
