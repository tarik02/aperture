import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { follow, read, request } from "@aperture-browser/e2e/src/http.ts";
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
import { signInThrough } from "./src/sso.ts";
import * as Proxy from "./src/proxy.ts";
import { totp } from "./src/totp.ts";

/** How long the longest check gets. */
const LONG = 300_000;
const ENTER = 13;
const ESCAPE = 27;
const BACKSPACE = 8;

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

/**
 * What a page shows that is pressed, or looked at for where it is: what moves while the
 * page comes to rest.
 */
const WATCHED = [
  "a",
  "button",
  "input",
  "main form",
  "[role^='menuitem']",
  "[role='option']",
  "[data-slot='dialog-content']",
  "[data-slot='sidebar-container']",
  "[data-sidebar-logo]",
  "[data-app-titlebar]",
  "[data-app-sidebar-titlebar]",
  "[data-app-window-titlebar]",
  "[data-workbench-titlebar]",
  "[data-console-session]",
  "[data-sonner-toast]",
].join(", ");

/** Where all that is watched is, while nothing of the page is on its way somewhere. */
const AT_REST = `(() => {
  const moving = document.getAnimations().some((one) => one.playState === "running" && Number.isFinite(Number(one.effect?.getComputedTiming().endTime ?? 0)));
  if (moving) {
    return null;
  }
  return [...document.querySelectorAll(${JSON.stringify(WATCHED)})]
    .map((one) => {
      const at = one.getBoundingClientRect();
      return [at.left, at.top, at.width, at.height].map(Math.round).join(" ");
    })
    .join("|");
})()`;

/**
 * Waits for a page to have come to rest: none of its animations and transitions that end
 * is still running, and all that is watched is where it was when last looked at, which is
 * some frames before. How long that takes is the machine's to say, and no wait of a set
 * length is long enough on one that is busy.
 */
const rested = (page: Viewer.Page) =>
  Effect.suspend(() => {
    let before: string | null = null;
    return until(
      "the page coming to rest",
      Effect.map(page.evaluate(AT_REST, Schema.NullOr(Schema.String)), (now) => {
        const same = now !== null && now === before;
        before = now;
        return same;
      }),
    );
  });

/**
 * Presses something for what is to come of it, unless that is there already: what is
 * pressed is pressed once it is at rest, and what comes of the press is waited for.
 */
const pressUntil = (page: Viewer.Page, selector: string, done: string) =>
  Effect.gen(function* () {
    if (yield* page.evaluate(`!!(${done})`, Schema.Boolean)) {
      return;
    }
    // From elsewhere: a press where the pointer already rests is one it did not move for.
    yield* page.mouse("mouseMoved", 1, 1);
    yield* page.click(selector);
    // What is asked may be an element, which the page hands over as nothing.
    yield* page.until(`!!(${done})`, "30 seconds");
  });

/**
 * How long a select's list takes no press of what it offers after it opened: the press
 * that opened it may still be held, and is not to choose what came under the pointer. It
 * is a clock of the select's own (400 ms in Base UI) that nothing on the page tells of,
 * so it is waited out, and what was pressed is seen to be chosen afterwards.
 */
const SELECT_TAKES_PRESSES_AFTER = "600 millis";

/** Chooses among what a select offers. */
const pick = (page: Viewer.Page, trigger: string, says: string) =>
  Effect.gen(function* () {
    yield* page.evaluate(
      `void document.querySelector(${JSON.stringify(trigger)}).scrollIntoView({ block: "nearest" })`,
    );
    const chosen = `document.querySelector(${JSON.stringify(trigger)}).textContent.includes(${JSON.stringify(says)}) && !document.querySelector('[data-slot="select-content"][data-open]')`;
    // What it stands in may still be settling into place, and a press beside it opens
    // nothing; and a press that came before the list took any closes it and chooses
    // nothing. So it is opened, and what it offers is pressed, until it says what was chosen.
    yield* until(
      `${says} being chosen`,
      Effect.gen(function* () {
        // A list that is closing is still there for a while, and offers nothing.
        const open = `!!document.querySelector('[data-slot="select-content"][data-open]') && !!document.querySelector('[data-slot="select-item"]')`;
        if (!(yield* page.evaluate(open, Schema.Boolean))) {
          yield* page.click(trigger);
          yield* page.until(open, "2 seconds");
        }
        yield* Effect.sleep(SELECT_TAKES_PRESSES_AFTER);
        yield* choose(page, `[data-slot="select-item"]`, says);
        yield* page.until(chosen, "2 seconds");
        return true;
      }),
      "30 seconds",
    );
  });

/**
 * The edge of the window a sidebar that is out of the way comes from when the pointer
 * rests there. It is there once the sidebar is out of the way, and not before.
 */
const EDGE = `[data-slot="sidebar-peek-zone"]`;

const DIALOG = `[data-slot="dialog-content"]`;
const BODY = `${DIALOG} [data-slot="dialog-body"] [data-slot="scroll-area-viewport"]`;
const BUTTONS = `${DIALOG} [data-slot="dialog-footer"]`;

/**
 * Where the open dialog is, and its buttons or what else is to stay put in it, once it has
 * come to rest. A dialog keeps its size whatever it holds, so its states are placed alike.
 */
const placed = (page: Viewer.Page, part = BUTTONS) =>
  Effect.gen(function* () {
    yield* page.until(
      `document.querySelector('${DIALOG}')?.getAnimations().every((one) => one.playState === "finished")`,
    );
    const dialog = yield* page.box(DIALOG);
    const kept = yield* page.box(part);
    return {
      left: dialog.left,
      top: dialog.top,
      width: dialog.width,
      height: dialog.height,
      part: [kept.left, kept.top, kept.height],
    };
  });

const alike = (states: ReadonlyArray<unknown>) =>
  expect(states).toEqual(states.map(() => states[0]));

/**
 * Whether the open dialog is as tall as what it holds, where it is given no height: none of
 * it is scrolled to, and there is no room in it that nothing stands in.
 */
const snug = (page: Viewer.Page) =>
  page.evaluate(
    `(() => {
      const body = document.querySelector('${BODY}');
      const last = body.lastElementChild.getBoundingClientRect();
      const room = body.getBoundingClientRect().bottom - parseFloat(getComputedStyle(body).paddingBottom) - last.bottom;
      return { scrolls: body.scrollHeight > body.clientHeight, room: Math.round(room) };
    })()`,
  );

/**
 * What of the open dialog is on screen: the whole of it, its title, all its buttons, and
 * what is typed into, which is seen in what scrolls between them.
 */
const onScreen = (page: Viewer.Page) =>
  page.evaluate(
    `(() => {
      const box = (one) => one.getBoundingClientRect();
      const within = (one) => {
        const at = box(one);
        return at.top >= 0 && at.bottom <= innerHeight && at.left >= 0 && at.right <= innerWidth;
      };
      const dialog = document.querySelector('${DIALOG}');
      const body = box(document.querySelector('${BODY}'));
      const typed = document.activeElement;
      return {
        dialog: within(dialog),
        title: within(dialog.querySelector('[data-slot="dialog-title"]')),
        buttons: [...document.querySelectorAll('${BUTTONS} button')].every(within),
        typed: dialog.contains(typed) && typed.matches("input") && box(typed).top >= body.top - 1 && box(typed).bottom <= body.bottom + 1,
      };
    })()`,
  );

/**
 * How the open dialog stands in a window wider than a phone's: at its right edge and as tall
 * as it, for what shows or changes a thing among others; in its middle, for what is short.
 */
const stands = (page: Viewer.Page) =>
  page.evaluate(
    `(() => {
      const at = document.querySelector('${DIALOG}').getBoundingClientRect();
      const side = Math.abs(at.right - innerWidth) <= 1 && at.top === 0 && Math.abs(at.height - innerHeight) <= 1 && at.left > 0;
      const middle = Math.abs((at.left + at.right) / 2 - innerWidth / 2) <= 1 && at.top > 0 && at.bottom < innerHeight;
      return side ? "side" : middle ? "middle" : "neither";
    })()`,
    Schema.String,
  );

const ALL_ON_SCREEN = { dialog: true, title: true, buttons: true, typed: true };

/** Goes to a tab of the account's page, from the sidebar. */
const toAccount = (page: Viewer.Page, tab: "security" | "tokens" | "connections") =>
  Effect.gen(function* () {
    const link = `[data-console-account-tab="${tab}"]`;
    yield* pressUntil(page, `a[href="/-/account"]`, `document.querySelector('${link}')`);
    yield* pressUntil(
      page,
      link,
      `document.querySelector('${link}')?.hasAttribute("data-active") && location.pathname === "/-/account/${tab}"`,
    );
  });

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

  it.effect("a link with a ticket of its own is let through the proxy, to what it is for", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const id = path.split("/").at(-1) ?? "";
      const api = `/api/control/sessions/${id}`;
      const Linked = Schema.Struct({ url: Schema.String });
      const linked = (at: string, body: object) =>
        request(proxy.url, ada.token, "POST", `${api}${at}`, body).pipe(
          Effect.flatMap((answer) => read(answer, Linked)),
        );
      // The node has no address of its own here: what is told is below the proxy's.
      const put = yield* linked("/file-links", { path: "uploads/linked.txt", write: true });
      expect(put.url.startsWith(`${proxy.url}${path}/uploads/linked.txt?token=`)).toBe(true);
      const said = new TextEncoder().encode("through the proxy");
      expect((yield* follow(put.url, "PUT", said)).status).toBe(200);
      const got = yield* linked("/file-links", { path: "uploads/linked.txt" });
      const fetched = yield* follow(got.url);
      expect([fetched.status, new TextDecoder().decode(fetched.bytes)]).toEqual([
        200,
        "through the proxy",
      ]);

      const ticket = new URL(got.url).searchParams.get("token") ?? "";
      // The link's ticket is the node's to hold to its one file.
      expect((yield* follow(`${proxy.url}${path}/targets?token=${ticket}`)).status).toBe(403);
      expect(
        (yield* follow(`${proxy.url}${path}/files/uploads/other.txt?token=${ticket}`)).status,
      ).toBe(403);
      // One that is no ticket of this control plane lets nobody in, nor one into a session elsewhere.
      const forged = `${ticket.slice(0, -4)}AAAA`;
      expect(
        (yield* follow(`${proxy.url}${path}/files/uploads/linked.txt?token=${forged}`)).status,
      ).toBe(401);
      const other = yield* ada.api.sessions.create({ payload: { suspended: true } });
      const elsewhere = `${proxy.url}${other.path ?? ""}/files/uploads/linked.txt?token=${ticket}`;
      expect((yield* follow(elsewhere)).status).toBe(401);
      yield* ada.api.sessions.delete({ params: { id: other.id } });

      // A ticket is carried on the request as well, as a program does that was handed one.
      const forPages = yield* ada.api.sessions.createTicket({
        params: { id },
        payload: { access: { cdp: "rw" } },
      });
      const version = `${path}/cdp/json/version`;
      expect((yield* request(proxy.url, forPages.ticket, "GET", version)).status).toBe(200);
      expect((yield* request(proxy.url, forPages.ticket, "PUT", `${path}/proxy`, {})).status).toBe(
        403,
      );

      // A ticket is its account's way in while the account is in use, and no longer.
      const control = yield* Control.Control;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const mate = yield* Control.account("Mate of the link");
      const theirs = yield* mate.api.sessions.create({ payload: {} });
      const watching = yield* mate.api.sessions.createTicket({
        params: { id: theirs.id },
        payload: {},
      });
      const watched = `${proxy.url}${theirs.path ?? ""}/targets?token=${watching.ticket}`;
      yield* until(
        "the mate's ticket letting them watch",
        follow(watched).pipe(Effect.map((answer) => answer.status === 200)),
        "60 seconds",
      );
      yield* bootstrap.accounts.disable({ params: { id: mate.account.id } });
      expect((yield* follow(watched)).status).toBe(401);
      yield* bootstrap.accounts.enable({ params: { id: mate.account.id } });
      expect((yield* follow(watched)).status).toBe(200);
      yield* mate.api.sessions.delete({ params: { id: theirs.id } });

      // A person is handed the session's page the same way.
      const handed = yield* linked("/tickets", {});
      expect(handed.url.startsWith(`${proxy.url}${path}/?token=`)).toBe(true);
      const page = yield* follow(handed.url);
      expect(page.status).toBe(200);
      expect(new TextDecoder().decode(page.bytes)).toMatch(/<html/iu);
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

  it.effect(
    "the console signs in with a token, lists the session and opens it",
    () =>
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
        yield* shot(page, fs, "console-token-create-invalid");
        yield* page.click(`[data-console-scope="sessions:read"]`);
        yield* page.until(
          `document.querySelector('[data-console-scope="sessions:read"]').hasAttribute("data-checked")`,
        );
        // It reaches all the account does, or only what is chosen: here the one session.
        yield* pick(page, `[data-console-token-reach] [data-slot="select-trigger"]`, "Only chosen");
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
        yield* page.evaluate(DARK);
        yield* shot(page, fs, "console-mcp-dark");
        yield* page.evaluate(AUTO);
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
      yield* shot(page, fs, "console-routing-proxy-invalid");
      routed.push(yield* placed(page));
      yield* routesAdded(DIALOG);
      yield* shot(page, fs, "console-routing-rules");
      yield* shotDark(page, fs, "console-routing-rules-dark");
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
      // were, whatever tab and proxy it shows.
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
      yield* shot(page, fs, "console-name-invalid");
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
      yield* shotDark(page, fs, "console-members-dark");
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
          yield* shot(short, fs, `console-phone-dialog-keyboard-${height}`);
          expect(yield* onScreen(short)).toEqual(ALL_ON_SCREEN);
          yield* closed(short);

          yield* short.evaluate(`void (location.href = "/-/workspaces")`);
          yield* short.until(`!!document.querySelector("[data-console-workspace-new]")`);
          yield* short.click("[data-console-workspace-new]");
          yield* short.until(
            `document.activeElement === document.querySelector("[data-console-name-dialog] input")`,
          );
          yield* placed(short);
          yield* shot(short, fs, `console-phone-name-dialog-keyboard-${height}`);
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
        const finger = (type: string, y?: number) =>
          page.cdp.call("Input.dispatchTouchEvent", {
            type,
            touchPoints: y === undefined ? [] : [{ x: stage.x, y }],
          });
        yield* finger("touchStart", stage.y + 200);
        for (let moved = 20; moved <= 300; moved += 20) {
          yield* finger("touchMove", stage.y + 200 - moved);
          yield* Effect.sleep("16 millis");
        }
        yield* finger("touchEnd");
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
        /** A finger put down, moved from one place to another, and lifted after a rest. */
        const drawn = (x: number, from: number, to: number) =>
          Effect.gen(function* () {
            const touch = (type: string, y?: number) =>
              page.cdp.call("Input.dispatchTouchEvent", {
                type,
                touchPoints: y === undefined ? [] : [{ x, y }],
              });
            yield* touch("touchStart", from);
            for (let step = 1; step <= 10; step += 1) {
              yield* touch("touchMove", from + ((to - from) * step) / 10);
              yield* Effect.sleep("16 millis");
            }
            // A finger that rests before it is lifted flings nothing on.
            yield* Effect.sleep("150 millis");
            yield* touch("touchEnd");
          });
        /** A finger moved along the window's width, as `drawn` moves one along its height. */
        const drawnAcross = (from: number, to: number, y: number) =>
          Effect.gen(function* () {
            const touch = (type: string, x?: number) =>
              page.cdp.call("Input.dispatchTouchEvent", {
                type,
                touchPoints: x === undefined ? [] : [{ x, y }],
              });
            yield* touch("touchStart", from);
            for (let step = 1; step <= 10; step += 1) {
              yield* touch("touchMove", from + ((to - from) * step) / 10);
              yield* Effect.sleep("16 millis");
            }
            yield* Effect.sleep("150 millis");
            yield* touch("touchEnd");
          });
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
      // The page before the reload has the field as well: the one after is waited for.
      yield* page.evaluate("void (window.beforeReload = true, location.reload())");
      yield* page.until(
        `!window.beforeReload && localStorage.length === 0 && !!document.querySelector("[data-console-invite] input")`,
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

      // How one signs in is a tab of the account's page: the second factor is told there to
      // be off, and is turned on in a dialog that asks the password first.
      yield* page.until(`!!document.querySelector("[data-console-security]")`);
      const dialog = (step: string) => `[data-console-security-dialog="${step}"]`;
      yield* toAccount(page, "security");
      yield* page.until(`!!document.querySelector('[data-console-second-factor="off"]')`);
      yield* shot(page, fs, "console-account-security");
      yield* shotDark(page, fs, "console-account-security-dark");
      yield* pressUntil(
        page,
        "[data-console-second-factor-change]",
        `document.querySelector('${dialog("none")} input')`,
      );
      // Nothing within a step moves its buttons; the dialog goes from one step to the
      // next, and is measured once it is there.
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
      // The codes are shown once, and closed by their own button: the page says it is on.
      yield* page.key("Escape", "Escape", ESCAPE);
      expect(yield* page.evaluate(`!!document.querySelector('${dialog("backup-codes")}')`)).toBe(
        true,
      );
      yield* choose(page, `${DIALOG} button`, "Done");
      yield* page.until(
        `!document.querySelector('${DIALOG}') && !!document.querySelector('[data-console-second-factor="on"]')`,
      );
      expect(
        yield* page.evaluate(`!!document.querySelector("[data-console-renew-backup-codes]")`),
      ).toBe(true);

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

  it.effect(
    "a list keeps what it is narrowed by in its address, and a tab that signs out or in takes the others along",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const control = yield* Control.Control;
        const viewer = yield* Viewer.Viewer;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const email = "odo@example.test";
        const password = "a password of Odo's own";
        const odo = yield* bootstrap.accounts.create({ payload: { name: "Odo", email } });
        const { token } = yield* bootstrap.accounts.createSetupToken({ params: { id: odo.id } });

        const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
        const asked = (path: string, body: object) =>
          page.evaluate(
            `fetch(${JSON.stringify(`/api/auth${path}`)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then((answer) => answer.status)`,
            Schema.Number,
          );
        const signIn = (tab: Viewer.Page) =>
          Effect.gen(function* () {
            yield* tab.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
            yield* rested(tab);
            yield* tab.click(`[data-console-sign-in] input[name="email"]`);
            yield* tab.type(email);
            yield* tab.click(`[data-console-sign-in] input[name="password"]`);
            yield* tab.type(password);
            yield* tab.key("Enter", "Enter", ENTER);
          });
        // The browser is the one the checks before signed in with: nothing of that is left.
        expect(yield* until("the page being there to sign out from", asked("/sign-out", {}))).toBe(
          200,
        );
        yield* page.evaluate(
          `(localStorage.clear(), fetch("/api/control/route/cookie", { method: "DELETE" }).then((answer) => answer.status))`,
        );
        expect(yield* asked("/reset-password", { token, newPassword: password })).toBe(200);
        yield* page.evaluate(`void (location.href = "/-/sessions")`);
        yield* signIn(page);
        yield* page.until(`!!document.querySelector("[data-console-create]")`);

        // What the list is narrowed by is in the address, and is there again after a reload.
        const sought = "nothing is called this";
        const search = `document.querySelector('input[type="search"]')`;
        const narrowed = `new URLSearchParams(location.search).get("q") === ${JSON.stringify(sought)} && new URLSearchParams(location.search).get("status") === "suspended"`;
        yield* rested(page);
        yield* page.click(`input[type="search"]`);
        yield* page.type(sought);
        yield* pick(page, `[data-slot="select-trigger"][aria-label="Status"]`, "Suspended");
        yield* page.until(narrowed);
        yield* page.evaluate("void location.reload()");
        yield* page.until(
          `${narrowed} && ${search}?.value === ${JSON.stringify(sought)} && document.querySelector('[data-slot="select-trigger"][aria-label="Status"]')?.textContent.includes("Suspended") && !!document.querySelector("[data-console-empty]")`,
        );

        // Another tab of the same browser is signed out with this one, where it was, and
        // has nothing of whoever was signed in left on it.
        const other = yield* viewer.open(`${proxy.url}/-/workspaces`);
        yield* other.until(`!!document.querySelector("[data-console-sign-out]")`);
        yield* rested(page);
        yield* page.click("[data-console-sign-out]");
        yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
        yield* placed(page);
        yield* page.click(`${BUTTONS} button:last-child`);
        yield* other.until(
          `!!document.querySelector('[data-console-sign-in="password"]') && !document.querySelector("[data-console-sign-out]") && location.pathname === "/-/workspaces"`,
        );
        // And signed in with the other, without being asked anything itself.
        yield* page.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
        yield* signIn(other);
        yield* other.until(`!!document.querySelector("[data-console-sign-out]")`);
        yield* page.until(`!!document.querySelector("[data-console-sign-out]")`);
        expect(page.errors()).toEqual([]);
        expect(other.errors()).toEqual([]);
        yield* other.close;
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

      // The passkeys are the list of the page that tells how one signs in, below the second
      // factor, which is no list; one is named in a dialog in the window's middle.
      const dialog = (step: string) => `[data-console-security-dialog="${step}"]`;
      const passkey = (name: string) => `[data-console-passkey="${name}"]`;
      const open = Effect.gen(function* () {
        yield* page.until(`!!document.querySelector("[data-console-security]")`);
        yield* toAccount(page, "security");
        yield* page.until(`!!document.querySelector("[data-console-security-page]")`);
      });
      const add = (name: string) =>
        Effect.gen(function* () {
          yield* pressUntil(
            page,
            "[data-console-passkey-add]",
            `document.activeElement === document.querySelector('${dialog("passkey-name")} input')`,
          );
          yield* page.type(name);
          yield* page.until(
            `document.querySelector('${dialog("passkey-name")} input').value === ${JSON.stringify(name)}`,
          );
        });
      yield* open;
      yield* present(true);
      yield* page.until(
        `!!document.querySelector("[data-console-passkeys-none] [data-console-empty]")`,
      );
      // One list on the page, and what else it tells is none.
      expect(
        yield* page.evaluate(
          `document.querySelectorAll('[data-console-security-page] [data-slot="item-group"], [data-console-security-page] table').length`,
        ),
      ).toBe(0);
      yield* shot(page, fs, "console-passkeys-none");
      // One is not added without a name.
      yield* page.click("[data-console-passkey-add]");
      yield* page.until(`!!document.querySelector('${dialog("passkey-name")} input')`);
      const naming = [yield* placed(page)];
      expect(yield* stands(page)).toBe("middle");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(
        `!!document.querySelector('${dialog("passkey-name")} [data-slot="field-error"]')`,
      );
      naming.push(yield* placed(page));
      alike(naming);
      yield* page.click(`${dialog("passkey-name")} input`);
      yield* page.type("Laptop");
      yield* shot(page, fs, "console-passkey-name");
      yield* shotDark(page, fs, "console-passkey-name-dark");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${passkey("Laptop")}')`);
      yield* page.until(`!document.querySelector('${DIALOG}')`);

      // It is named anew.
      yield* page.click(`${passkey("Laptop")} [data-console-passkey-rename]`);
      yield* page.until(
        `document.activeElement === document.querySelector('${dialog("passkey-name")} input')`,
      );
      yield* page.type(" of Pia");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${passkey("Laptop of Pia")}')`);
      yield* page.until(`!document.querySelector('${DIALOG}')`);
      expect(
        yield* page.evaluate(
          `document.querySelectorAll('[data-console-security-page] [data-slot="item-group"]').length`,
        ),
      ).toBe(1);
      yield* shot(page, fs, "console-passkeys");
      yield* shotDark(page, fs, "console-passkeys-dark");

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
      yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
      yield* placed(page);
      yield* shot(page, fs, "console-passkey-remove");
      yield* page.click(`${BUTTONS} button:last-child`);
      yield* page.until(
        `!!document.querySelector("[data-console-passkeys-none] [data-console-empty]")`,
      );
      yield* page.until(`!document.querySelector('${DIALOG}')`);

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
      // A person is made at the window's side, as what shows one is.
      expect(yield* stands(page)).toBe("side");
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
      // Whoever was made is to set a password: the link for it is shown at once.
      yield* page.until(`!!document.querySelector("[data-console-secret]")`);
      expect(yield* page.text("[data-console-secret]")).toContain(
        `email=${encodeURIComponent("lin@example.test")}`,
      );
      yield* choose(page, `${DIALOG} button`, "Done");
      // The dialogs are in the way of the row until they have closed.
      yield* page.until(
        `!document.querySelector('${person}') && !document.querySelector("[data-console-secret]")`,
      );
      // People are told apart from what is not a person, and no token is made for them here.
      expect(yield* page.evaluate(`!!document.querySelector("[data-console-service]")`)).toBe(
        false,
      );
      expect(yield* page.text(lin)).not.toContain("API token");
      // The link is among what else is done with a person, in their menu and nowhere beside it.
      expect(yield* page.evaluate(`document.querySelectorAll('${lin} button').length`)).toBe(1);
      yield* page.click(`${lin} [data-console-person-actions]`);
      yield* page.until(`!!document.querySelector('[data-console-person-action="setup-link"]')`);
      yield* rested(page);
      yield* shot(page, fs, "console-people");
      yield* page.click(`[data-console-person-action="setup-link"]`);
      yield* page.until(`!!document.querySelector("[data-console-secret]")`);
      expect(yield* page.text("[data-console-secret]")).toContain("/invite#token=");
      yield* choose(page, `${DIALOG} button`, "Done");
      yield* page.until(`!document.querySelector("[data-console-secret]")`);

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
      // A person is opened at the window's side: what is known of them, and below it the
      // workspaces they are in, where an admin lets them in and out and says as what.
      const linId = (yield* root.api.accounts.list()).find((one) => one.name === "Lin")?.id ?? "";
      const team = yield* root.api.workspaces.create({ payload: { name: "Team of Lin" } });
      const place = `[data-console-account-workspace="Team of Lin"]`;
      const roleOf = (accountId: string) =>
        Effect.map(
          root.api.workspaces.ofAccount({ params: { accountId } }),
          (all) => all.find((one) => one.id === team.id)?.role ?? null,
        );
      /** Lets whoever the open sheet shows into the workspace, changes what they do there, and takes them out. */
      const placedAndTaken = (accountId: string, name: string) =>
        Effect.gen(function* () {
          yield* page.until(`!!document.querySelector("[data-console-account-facts]")`);
          // Once it has come to rest where it stands.
          yield* placed(page, `${DIALOG} [data-console-account-place]`);
          expect(yield* stands(page)).toBe("side");
          expect(yield* page.text("[data-console-account-id]")).toBe(accountId);
          yield* page.until(`!!document.querySelector('${DIALOG} [data-console-empty]')`);
          const sheet = [yield* placed(page, `${DIALOG} [data-console-account-place]`)];
          // One list in it, below what is known of the account.
          expect(
            yield* page.evaluate(
              `document.querySelectorAll('${DIALOG} [data-slot="item-group"], ${DIALOG} table').length`,
            ),
          ).toBe(0);
          yield* pick(page, "[data-console-account-place-workspace]", "Team of Lin");
          yield* page.click(`[data-console-account-place] button[type="submit"]`);
          yield* page.until(`!!document.querySelector('${place}')`);
          expect(yield* roleOf(accountId)).toBe("member");
          // What they do there is said in words, and changed where it is said.
          expect(yield* page.text(`${place} [data-slot="select-value"]`)).toBe("Member");
          sheet.push(yield* placed(page, `${DIALOG} [data-console-account-place]`));
          yield* shot(page, fs, `console-account-sheet-${name}`);
          yield* shotDark(page, fs, `console-account-sheet-${name}-dark`);
          yield* pick(page, `${place} [data-slot="select-trigger"]`, "Admin");
          yield* until(
            "the role being changed",
            Effect.map(roleOf(accountId), (role) => role === "admin"),
          );
          yield* page.click(`${place} [data-console-account-unplace]`);
          yield* page.until(`document.querySelectorAll('${DIALOG}').length === 2`);
          yield* choose(page, `${BUTTONS} button`, "Remove");
          yield* page.until(`!document.querySelector('${place}')`);
          yield* page.until(`document.querySelectorAll('${DIALOG}').length === 1`);
          expect(yield* roleOf(accountId)).toBe(null);
          sheet.push(yield* placed(page, `${DIALOG} [data-console-account-place]`));
          alike(sheet);
          yield* closed(page);
        });
      // A row tells two lines of a person, and is as tall as any row that does.
      expect(
        yield* page.evaluate(`document.querySelector('${lin} td').children[0].children.length`),
      ).toBe(2);
      expect(yield* page.text(lin)).not.toContain(linId);
      expect(yield* page.text(lin)).toContain("Member");
      yield* page.click(`${lin} td`);
      yield* placedAndTaken(linId, "person");

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
      // It is let into a workspace from where it is opened: it has no address to be found by.
      const botAccount = (yield* root.api.accounts.list()).find((one) => one.name === "Deploy bot");
      yield* page.click(`${bot} td`);
      yield* placedAndTaken(botAccount?.id ?? "", "service");
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
      // The dialog is still coming to rest when its field is there: a press beside the
      // box ticks nothing, so it is pressed until it is ticked.
      yield* pressUntil(
        page,
        `[data-console-scope="sessions:write"]`,
        `document.querySelector('[data-console-scope="sessions:write"]').hasAttribute("data-checked")`,
      );
      yield* shot(page, fs, "console-service-token");
      yield* nameToken(page, "deploys");
      yield* page.until(`!!document.querySelector("[data-console-secret]")`);
      const withIt = yield* control.as((yield* page.text("[data-console-secret]")) ?? "");
      const whose = yield* withIt.accounts.current();
      expect([whose.name, whose.kind]).toEqual(["Deploy bot", "service"]);
      yield* withIt.sessions.list({ query: {} });
      expect((yield* Effect.flip(withIt.snapshots.list({ query: {} })))._tag).toBe("Forbidden");
      yield* choose(page, `${DIALOG} button`, "Done");
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
      yield* page.until(`document.querySelector('${spared}')?.textContent.includes("Revoked")`);
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
      yield* page.until(`document.querySelector('${spare}')?.textContent.includes("Revoked")`);
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
    "an admin adds a sign-in provider in the console, checks it, disables it and removes it",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const control = yield* Control.Control;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const dex = yield* Dex.Address;
        const root = yield* Control.account("Provider admin", true);
        const [added] = Dex.ADDED;
        const offered = Effect.map(
          request(control.url, "", "GET", "/api/control/sign-in/providers"),
          (answer) => JSON.stringify(answer.body),
        );

        const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
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

        // The provider the settings name is told among them, and nothing is done with it here.
        yield* page.until(`!!document.querySelector('a[href="/-/sign-in-providers"]')`);
        yield* page.click(`a[href="/-/sign-in-providers"]`);
        const configured = `[data-console-provider="${Dex.PROVIDER}"]`;
        yield* page.until(`!!document.querySelector('${configured}')`);
        expect(yield* page.text(configured)).toContain("From configuration");
        expect(yield* page.evaluate(`!!document.querySelector('${configured} button')`)).toBe(
          false,
        );

        const form = "[data-console-provider-form]";
        const reached = (state: string) =>
          page.until(`!!document.querySelector('[data-console-provider-reached="${state}"]')`);
        /** Types into a field of the form, and sees it there before anything else is done. */
        const fill = (name: string, text: string) =>
          Effect.gen(function* () {
            const field = `document.querySelector('${form} input[name="${name}"]')`;
            yield* page.evaluate(`void ${field}.scrollIntoView({ block: "nearest" })`);
            yield* rested(page);
            yield* page.click(`${form} input[name="${name}"]`);
            yield* page.until(`document.activeElement === ${field}`);
            // In place of what a preset put there.
            yield* page.evaluate(`void ${field}.select()`);
            yield* page.type(text);
            yield* page.until(`${field}.value === ${JSON.stringify(text)}`);
          });
        const typed = (name: string) =>
          page.evaluate(`document.querySelector('${form} input[name="${name}"]').value`);
        /** The scopes that are chosen, as the form shows them. */
        const scopes = page.evaluate(
          `[...document.querySelectorAll('${form} [data-scope]')].map((one) => one.dataset.scope).join(" ")`,
        );
        const opened = Effect.gen(function* () {
          yield* page.click("[data-console-provider-new]");
          yield* page.until(`!!document.querySelector('${form} input[name="name"]')`);
          yield* rested(page);
          return yield* placed(page);
        });

        // What is no provider is said to be none in the field itself, and why opens beside
        // it: nothing moves.
        const states = [yield* opened];
        yield* fill("issuer", `${control.url}/nowhere`);
        yield* page.click("[data-console-provider-check]");
        yield* reached("refused");
        yield* page.until(`!!document.querySelector("[data-console-provider-problems]")`);
        expect(yield* page.text("[data-console-provider-problems]")).toContain("/nowhere");
        states.push(yield* placed(page));
        yield* shot(page, fs, "console-provider-check-refused");
        // Escape closes what is open above the form first, and then the form.
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector("[data-console-provider-problems]")`);
        expect(yield* page.text("[data-console-provider-reached]")).toContain("Not reached");
        yield* closed(page);

        // Begun anew, the form is empty. A provider that is known fills in what is known
        // of it: what it is called and known by, and what is asked of it.
        states.push(yield* opened);
        expect(yield* typed("issuer")).toBe("");
        yield* pick(page, "[data-console-provider-preset]", "Keycloak");
        yield* page.until(`!!document.querySelector('${form} input[name="parts.realm"]')`);
        expect([yield* typed("name"), yield* typed("id")]).toEqual(["Keycloak", "keycloak"]);
        // Its issuer is made of what is its own there, and is not typed.
        yield* fill("parts.base", "https://sso.example.test/");
        yield* fill("parts.realm", "people");
        expect(yield* typed("issuer")).toBe("https://sso.example.test/realms/people");
        // One that speaks OAuth 2.0 alone has no issuer: where it is asked is its own, and
        // so is what is asked of it.
        yield* pick(page, "[data-console-provider-preset]", "GitHub");
        yield* page.until(`!!document.querySelector('${form} input[name="authorization"]')`);
        expect([yield* typed("name"), yield* typed("id"), yield* typed("authorization")]).toEqual([
          "GitHub",
          "github",
          "https://github.com/login/oauth/authorize",
        ]);
        expect(yield* scopes).toBe("read:user user:email");
        yield* pick(page, "[data-console-provider-preset]", "Dex");
        yield* page.until(`!!document.querySelector('${form} input[name="issuer"]')`);
        // Each that is known is offered with its own mark, and chosen with it.
        expect(
          yield* page.evaluate(
            `!!document.querySelector('[data-console-provider-preset] [data-provider-mark="dex"]')`,
          ),
        ).toBe(true);
        expect([yield* typed("name"), yield* typed("id"), yield* typed("issuer")]).toEqual([
          "Dex",
          "dex",
          "",
        ]);
        expect(yield* scopes).toBe("openid email profile");
        // The address to register follows the id as typed.
        yield* fill("name", "Company");
        yield* fill("id", added);
        expect(
          yield* page.evaluate(`document.querySelector("[data-console-provider-callback]").value`),
        ).toBe(`${proxy.url}/api/auth/callback/${added}`);
        yield* fill("issuer", dex.issuer);
        yield* page.click("[data-console-provider-check]");
        yield* reached("reached");
        // Reached, it offers the scopes it says it gives; one it does not say is typed.
        // Nothing is typed into the field: pressed, it opens the list, whose own field is
        // typed into.
        const picker = `${form} [data-slot="scopes-picker"]`;
        expect(yield* page.evaluate(`!!document.querySelector('${picker} input')`)).toBe(false);
        yield* page.evaluate(
          `void document.querySelector('${picker}').scrollIntoView({ block: "center" })`,
        );
        yield* rested(page);
        yield* pressUntil(page, picker, `document.querySelector('[data-scope-option="groups"]')`);
        expect(
          yield* page.evaluate(
            `!!document.querySelector('[data-scope-option="openid"][data-disabled]')`,
          ),
        ).toBe(true);
        yield* rested(page);
        yield* pressUntil(
          page,
          `[data-scope-option="groups"]`,
          `document.querySelector('${form} [data-scope="groups"]')`,
        );
        yield* page.until(
          `document.activeElement === document.querySelector('[data-slot="combobox-content"] input')`,
        );
        yield* page.type("federated:id");
        yield* page.until(
          `!!document.querySelector('[data-scope-option="federated:id"][data-scope-typed]')`,
        );
        yield* rested(page);
        yield* shot(page, fs, "console-provider-scopes");
        yield* page.key("Enter", "Enter", ENTER);
        yield* page.until(`!!document.querySelector('${form} [data-scope="federated:id"]')`);
        // Escape closes the list where it is still open, and nothing else: the form stays,
        // with what was chosen.
        const listed = `!!document.querySelector('[data-slot="combobox-content"][data-open]')`;
        if (yield* page.evaluate(listed, Schema.Boolean)) {
          yield* page.key("Escape", "Escape", ESCAPE);
          yield* page.until(`!(${listed})`);
        }
        expect(yield* scopes).toBe("openid email profile groups federated:id");
        yield* page.evaluate(
          `void document.querySelector('${form} input[name="name"]').scrollIntoView({ block: "center" })`,
        );
        yield* rested(page);
        states.push(yield* placed(page));
        yield* shot(page, fs, "console-provider-new");
        yield* shotDark(page, fs, "console-provider-new-dark");
        // Without a client, it is not sent, and is told what it lacks where it stays.
        yield* page.click(`${BUTTONS} button[type="submit"]`);
        yield* page.until(`!!document.querySelector('${form} [data-slot="field-error"]')`);
        states.push(yield* placed(page));
        alike(states);
        yield* fill("clientId", dex.clientId);
        yield* fill("clientSecret", dex.clientSecret);
        yield* page.key("Enter", "Enter", ENTER);
        const row = `[data-console-provider="${added}"]`;
        yield* page.until(
          `!document.querySelector('${DIALOG}') && !!document.querySelector('${row}')`,
        );
        expect(yield* offered).toContain(`"id":"${added}"`);
        // Someone an admin made a person signs in through it, with the scopes it was given.
        const [, , carol] = Dex.VERIFIED;
        const bootstrap = yield* control.as(control.bootstrapToken);
        yield* bootstrap.accounts.create({ payload: { name: "Carol", email: carol.email } });
        const landed = yield* signInThrough(proxy.url, "local", carol.email, undefined, added);
        expect(landed.at).toBe("/-/sessions");
        // The secret is nowhere on the page once it was given.
        expect(
          yield* page.evaluate(
            `document.body.innerHTML.includes(${JSON.stringify(dex.clientSecret)})`,
          ),
        ).toBe(false);
        // It is shown with the mark of the provider it was made from, here and to whoever
        // signs in; the one the settings name said none, and has none of any provider's.
        expect(
          yield* page.evaluate(`!!document.querySelector('${row} [data-provider-mark="dex"]')`),
        ).toBe(true);
        expect(
          yield* page.evaluate(`!!document.querySelector('${configured} [data-provider-mark=""]')`),
        ).toBe(true);
        expect(yield* offered).toMatch(new RegExp(`"id":"${added}"[^}]*"icon":"dex"`, "u"));
        yield* rested(page);
        yield* shot(page, fs, "console-providers");
        yield* shotDark(page, fs, "console-providers-dark");

        // Its row's menu disables it, and a right click on the row enables it again.
        const does = (says: string) =>
          Effect.gen(function* () {
            yield* rested(page);
            yield* page.click(`${row} [aria-label="Provider actions"]`);
            yield* choose(page, `[data-slot="dropdown-menu-item"]`, says);
          });
        const state = (is: string) =>
          page.until(`!!document.querySelector('${row} [data-console-provider-state="${is}"]')`);
        yield* does("Disable");
        yield* state("disabled");
        expect(yield* offered).not.toContain(`"id":"${added}"`);
        yield* rested(page);
        const at = yield* page.box(row);
        yield* page.clickAt(at.x, at.y, "right");
        yield* page.until(
          `[...document.querySelectorAll('[data-slot="context-menu-item"]')].some((item) => item.textContent.includes("Enable"))`,
        );
        yield* shot(page, fs, "console-provider-context");
        yield* choose(page, `[data-slot="context-menu-item"]`, "Enable");
        yield* state("enabled");
        expect(yield* offered).toContain(`"id":"${added}"`);

        // Changed, it keeps what it is known by and its secret, which is not shown.
        yield* does("Edit");
        yield* page.until(`!!document.querySelector('${form} input[name="id"]')`);
        yield* rested(page);
        expect(
          yield* page.evaluate(
            `(() => { const form = document.querySelector('${form}'); return [form.querySelector('input[name="id"]').disabled, form.querySelector('input[name="id"]').value, form.querySelector('input[name="clientSecret"]').value, form.querySelector('input[name="clientSecret"]').placeholder].join("|"); })()`,
          ),
        ).toBe(`true|${added}||Unchanged`);
        // What was asked of it is what it is asked for still.
        expect(yield* scopes).toBe("openid email profile groups federated:id");
        alike([states[0], yield* placed(page)]);
        yield* shot(page, fs, "console-provider-edit");
        yield* shotDark(page, fs, "console-provider-edit-dark");
        yield* closed(page);

        // On a phone a provider is a block of its own, and its form fits the screen.
        const phone = yield* viewer.open(`${proxy.url}/-/sign-in-providers`, {
          width: 390,
          height: 844,
          mobile: true,
        });
        yield* phone.until(`!!document.querySelector('${row}')`);
        yield* rested(phone);
        yield* shot(phone, fs, "console-phone-providers");
        yield* shotDark(phone, fs, "console-phone-providers-dark");
        expect(yield* phone.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
          true,
        );
        yield* phone.click(`${row} [aria-label="Provider actions"]`);
        yield* choose(phone, `[data-slot="dropdown-menu-item"]`, "Edit");
        yield* phone.until(`!!document.querySelector('${form} input[name="id"]')`);
        yield* rested(phone);
        yield* shot(phone, fs, "console-phone-provider-edit");
        yield* shotDark(phone, fs, "console-phone-provider-edit-dark");
        expect(yield* phone.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
          true,
        );
        yield* phone.close;

        // Removed once that is said again, it is gone from the page and from who is offered.
        yield* does("Remove");
        yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
        yield* placed(page);
        yield* shot(page, fs, "console-provider-remove");
        yield* page.click(`${BUTTONS} button:last-child`);
        yield* page.until(`!document.querySelector('${row}')`);
        expect(yield* offered).not.toContain(`"id":"${added}"`);
        expect(yield* page.evaluate(`!!document.querySelector('${configured}')`)).toBe(true);
        expect(page.errors()).toEqual([]);
      }),
    LONG,
  );

  it.effect("the console offers a token what it is for, and nothing the API would refuse it", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const control = yield* Control.Control;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const owner = yield* Control.account("Owner", true);
      const team = yield* owner.api.workspaces.create({ payload: { name: "Team of the held" } });
      const own = yield* until(
        "a session on the node that registered",
        owner.api.sessions.create({ payload: { suspended: true, label: "Owner's own" } }),
        "30 seconds",
      );
      const shared = yield* owner.api.sessions.create({
        payload: { suspended: true, label: "The team's", workspaceId: team.id },
      });
      const reader = yield* owner.api.accounts.createOwnToken({
        payload: { name: "reader", scopes: ["sessions:read"] },
      });
      const held = yield* owner.api.accounts.createOwnToken({
        payload: {
          name: "held",
          scopes: ["sessions:write", "snapshots:write"],
          resources: { workspaces: [team.id], sessions: [], snapshots: [] },
        },
      });

      const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
      // Whoever was signed in before is not, and a token is given in their place.
      const signIn = (token: string) =>
        Effect.gen(function* () {
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
          yield* page.type(token);
          yield* page.key("Enter", "Enter", ENTER);
          yield* page.until(`!!document.querySelector('a[href="/-/workspaces"]')`);
          yield* page.evaluate(`void performance.setResourceTimingBufferSize(2000)`);
        });
      const has = (selector: string) =>
        page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`, Schema.Boolean);
      const menuOf = (card: string) =>
        Effect.gen(function* () {
          yield* page.click(`${card} [aria-label="Session actions"]`);
          yield* page.until(`!!document.querySelector('[data-slot="dropdown-menu-item"]')`);
          return yield* page.evaluate(
            `[...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].map((item) => item.textContent.trim())`,
            Schema.Array(Schema.String),
          );
        });
      /** What the page asked of the API and was refused, since it was last loaded. */
      const refused = page.evaluate(
        `performance.getEntriesByType("resource").filter((asked) => asked.responseStatus === 403).map((asked) => new URL(asked.name).pathname)`,
        Schema.Array(Schema.String),
      );
      const menuClosed = Effect.gen(function* () {
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector('[data-slot="dropdown-menu-item"]')`);
      });

      // A token that reads sessions sees them, and is offered nothing that changes one.
      yield* signIn(reader.token);
      const ownCard = `[data-console-session="${own.id}"]`;
      yield* page.until(`!!document.querySelector('${ownCard}')`);
      expect(yield* has("[data-console-create]")).toBe(false);
      expect(yield* has(`${ownCard} input[type="checkbox"]`)).toBe(false);
      // It is an admin's, and not for what an admin does, nor for anything else there is.
      for (const gone of ["snapshots", "account", "people", "nodes", "audit"]) {
        expect([gone, yield* has(`a[href="/-/${gone}"]`)]).toEqual([gone, false]);
      }
      expect(yield* menuOf(ownCard)).toEqual(["Open", "Copy link", "Details"]);
      yield* shot(page, fs, "console-held-reader");
      yield* shotDark(page, fs, "console-held-reader-dark");
      yield* menuClosed;
      yield* page.click(`${ownCard} [data-console-session-footer]`, "right");
      yield* page.until(`!!document.querySelector("[data-console-session-context]")`);
      expect(yield* page.text("[data-console-session-context]")).not.toContain("Delete");
      yield* page.key("Escape", "Escape", ESCAPE);
      yield* page.until(`!document.querySelector("[data-console-session-context]")`);
      // Workspaces are told to all; who is in one, and making and changing one, is for a
      // token that is for it.
      yield* page.click(`a[href="/-/workspaces"]`);
      const row = `[data-console-workspace="Team of the held"]`;
      yield* page.until(`!!document.querySelector('${row}')`);
      expect(yield* has("[data-console-workspace-new]")).toBe(false);
      expect(yield* has(`${row} [data-console-row-action="members"]`)).toBe(false);
      expect(yield* has(`${row} [data-console-row-actions]`)).toBe(false);
      yield* shot(page, fs, "console-held-reader-workspaces");
      // A page that is not the token's says so, where its address is come to.
      yield* page.evaluate(
        `void (history.pushState({}, "", "/-/account/tokens"), dispatchEvent(new PopStateEvent("popstate")))`,
      );
      yield* page.until(`!!document.querySelector('[data-console-not-allowed="tokens:write"]')`);
      yield* shot(page, fs, "console-held-not-allowed");
      const phone = yield* viewer.open(`${proxy.url}/-/sessions`, {
        width: 390,
        height: 844,
        mobile: true,
      });
      yield* phone.until(`!!document.querySelector('${ownCard}')`);
      expect(yield* phone.evaluate(`!!document.querySelector("[data-console-create]")`)).toBe(
        false,
      );
      yield* shot(phone, fs, "console-phone-held-reader");
      expect(yield* phone.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
        true,
      );
      yield* phone.close;
      // Nothing was asked of the API that it refuses this token.
      expect(yield* refused).toEqual([]);
      expect(page.errors()).toEqual([]);

      // A token held to a workspace sees what is there, and makes sessions there alone.
      yield* signIn(held.token);
      yield* page.until(`!!document.querySelector("[data-console-empty]")`);
      expect(yield* has(ownCard)).toBe(false);
      expect(yield* has("[data-console-create]")).toBe(false);
      yield* shot(page, fs, "console-held-personal");
      yield* page.click("[data-console-workspace-switcher]");
      yield* choose(page, `[data-slot="dropdown-menu-radio-item"]`, "Team of the held");
      const sharedCard = `[data-console-session="${shared.id}"]`;
      yield* page.until(`!!document.querySelector('${sharedCard}')`);
      // The list stays for another choice, and is in the way of what is under it.
      yield* page.key("Escape", "Escape", ESCAPE);
      yield* page.until(`!document.querySelector('[data-slot="dropdown-menu-radio-item"]')`);
      yield* page.until(`!!document.querySelector("[data-console-create]")`);
      expect(yield* has(`a[href="/-/snapshots"]`)).toBe(true);
      expect(yield* has(`a[href="/-/account"]`)).toBe(false);
      const offered = yield* menuOf(sharedCard);
      expect(offered).toEqual(expect.arrayContaining(["Share", "Save to snapshot", "Delete"]));
      yield* shot(page, fs, "console-held-workspace");
      yield* shotDark(page, fs, "console-held-workspace-dark");
      yield* menuClosed;
      // Its own server is told of with no token to make for it: this one makes none.
      yield* fromMenu(page, sharedCard, "Details");
      yield* closed(page);
      expect(yield* refused).toEqual([]);
      expect(page.errors()).toEqual([]);

      yield* Effect.forEach([own.id, shared.id], (id) =>
        owner.api.sessions.delete({ params: { id } }),
      );
      expect((yield* (yield* control.as(reader.token)).accounts.current()).scopes).toEqual([
        "sessions:read",
      ]);
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

        yield* page.until(`!!document.querySelector('a[href="/-/audit"]')`);
        expect(yield* page.text(`a[href="/-/audit"]`)).toBe("Audit");
        yield* page.click(`a[href="/-/audit"]`);
        yield* page.until(`document.title === "Aperture | Audit"`);
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
        yield* shot(page, fs, "console-audit");
        yield* shotDark(page, fs, "console-audit-dark");
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
        yield* rested(page);
        yield* shot(page, fs, "console-audit-kinds");
        yield* shotDark(page, fs, "console-audit-kinds-dark");
        yield* pick(page, `[aria-label="Kind of event"]`, "All events");
        yield* page.until(`${rows}.length >= 50`);

        // By who did it, by a part of what they are called.
        yield* page.click("[data-console-events-actor]");
        yield* page.type("quil");
        yield* page.until(
          `${rows}.length === 1 && ${rows}[0].textContent.includes("Quill") && ${rows}[0].textContent.includes("Made the workspace")`,
        );
        yield* shot(page, fs, "console-audit-actor");
        yield* page.click("[data-console-events-actor]");
        yield* page.type("-nobody-is-called-this");
        // Nothing matches, which is not that there is nothing: what narrowed the list is
        // taken back from there, and the list is whole again.
        yield* page.until(`!!document.querySelector('[data-console-empty="no-match"]')`);
        yield* shot(page, fs, "console-audit-no-match");
        yield* page.click("[data-console-clear-filters]");
        yield* page.until(
          `${rows}.length >= 50 && document.querySelector("[data-console-events-actor]").value === "" && location.search === ""`,
        );

        // On a phone an event is a block of its own, and what narrows the list is two
        // buttons in the title bar: the search opens below it, the kinds in a menu.
        const phone = yield* viewer.open(`${proxy.url}/-/audit`, {
          width: 390,
          height: 844,
          mobile: true,
        });
        yield* phone.until(`${rows}.length === 50`);
        yield* shot(phone, fs, "console-phone-audit");
        const scheme = (value: string) =>
          phone.cdp.call("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value }],
          });
        yield* scheme("dark");
        yield* shot(phone, fs, "console-phone-audit-dark");
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
        yield* rested(phone);
        yield* shot(phone, fs, "console-phone-audit-kinds");
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
        yield* shot(phone, fs, "console-phone-audit-search");
        expect(phone.errors()).toEqual([]);
        yield* phone.close;

        // The page's address says what it is narrowed by.
        const wide = yield* viewer.open(`${proxy.url}/-/audit?kind=workspace.deleted`, {
          width: 1440,
          height: 900,
        });
        yield* wide.until(`${rows}.length === 1`);
        yield* wide.evaluate(`void (location.href = "/-/audit")`);
        yield* wide.until(`${rows}.length === 50`);
        yield* shot(wide, fs, "console-audit-wide");
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
      yield* page.evaluate(`void (location.href = "/-/account/connections")`);
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
            // The provider's page is there before it takes a press, on a busy machine.
            yield* pressUntil(
              page,
              `a[href*="/dex/auth/local"]`,
              `document.querySelector('input[name="login"]')`,
            );
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
