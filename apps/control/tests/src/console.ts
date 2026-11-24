import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { request } from "@aperture-browser/e2e/src/http.ts";
import { directory, logsDirectory } from "@aperture-browser/e2e/src/process.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Control from "./control.ts";
import * as Dex from "./dex.ts";
import * as Proxy from "./proxy.ts";

/**
 * What the checks of the console and of what stands before it share: the control plane
 * behind a proxy, with a node, a sign-in provider and a browser, and how a page of the
 * console is pressed and looked at.
 */
/** How long the longest check gets. */
export const LONG = 300_000;
export const ENTER = 13;
export const ESCAPE = 27;
export const BACKSPACE = 8;

export const Shot = Schema.Struct({ data: Schema.String });

/** Keeps what a page shows, where the checks' logs are asked for: for whoever wants to look. */
export const shot = (page: Viewer.Page, fs: FileSystem.FileSystem, name: string) =>
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
export const noteStarting = (page: Viewer.Page) =>
  page.evaluate(
    `void (window.startedAt = undefined, new MutationObserver(() => {
      if (window.startedAt === undefined && document.querySelector('[data-console-session-note="asked"]')) {
        window.startedAt = location.pathname;
      }
    }).observe(document.body, { childList: true, subtree: true }))`,
  );

/** Waits for a session that was asked for to have its own address, which took the place of the first. */
export const started = (page: Viewer.Page) =>
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
export const theme = (label: string) =>
  `(document.startViewTransition = undefined, void document.querySelector('[role="radio"][aria-label="${label}"]').click())`;
/** Presses what a list that opened offers, by what it says. */
export const choose = (page: Viewer.Page, items: string, says: string) =>
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
export const nameToken = (page: Viewer.Page, name: string) =>
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

export const DARK = theme("Dark");
export const AUTO = theme("Auto");

/**
 * What a page shows that is pressed, or looked at for where it is: what moves while the
 * page comes to rest.
 */
export const WATCHED = [
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
export const AT_REST = `(() => {
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
export const rested = (page: Viewer.Page) =>
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
export const pressUntil = (page: Viewer.Page, selector: string, done: string) =>
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
export const SELECT_TAKES_PRESSES_AFTER = "600 millis";

/** Chooses among what a select offers. */
export const pick = (page: Viewer.Page, trigger: string, says: string) =>
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
export const EDGE = `[data-slot="sidebar-peek-zone"]`;

export const DIALOG = `[data-slot="dialog-content"]`;
export const BODY = `${DIALOG} [data-slot="dialog-body"] [data-slot="scroll-area-viewport"]`;
export const BUTTONS = `${DIALOG} [data-slot="dialog-footer"]`;

/**
 * Where the open dialog is, and its buttons or what else is to stay put in it, once it has
 * come to rest. A dialog keeps its size whatever it holds, so its states are placed alike.
 */
export const placed = (page: Viewer.Page, part = BUTTONS) =>
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

export const alike = (states: ReadonlyArray<unknown>) =>
  expect(states).toEqual(states.map(() => states[0]));

/**
 * Whether the open dialog is as tall as what it holds, where it is given no height: none of
 * it is scrolled to, and there is no room in it that nothing stands in.
 */
export const snug = (page: Viewer.Page) =>
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
export const onScreen = (page: Viewer.Page) =>
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
export const stands = (page: Viewer.Page) =>
  page.evaluate(
    `(() => {
      const at = document.querySelector('${DIALOG}').getBoundingClientRect();
      const side = Math.abs(at.right - innerWidth) <= 1 && at.top === 0 && Math.abs(at.height - innerHeight) <= 1 && at.left > 0;
      const middle = Math.abs((at.left + at.right) / 2 - innerWidth / 2) <= 1 && at.top > 0 && at.bottom < innerHeight;
      return side ? "side" : middle ? "middle" : "neither";
    })()`,
    Schema.String,
  );

export const ALL_ON_SCREEN = { dialog: true, title: true, buttons: true, typed: true };

/** Goes to a tab of the account's page, from the sidebar. */
export const toAccount = (page: Viewer.Page, tab: "security" | "tokens" | "connections") =>
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
export const fromMenu = (page: Viewer.Page, card: string, says: string) =>
  Effect.gen(function* () {
    yield* page.click(`${card} [aria-label="Session actions"]`);
    yield* choose(page, `[data-slot="dropdown-menu-item"]`, says);
    yield* page.until(`!!document.querySelector('${DIALOG}')`);
  });

export const closed = (page: Viewer.Page) =>
  Effect.gen(function* () {
    yield* page.key("Escape", "Escape", ESCAPE);
    yield* page.until(`!document.querySelector('${DIALOG}')`);
  });

/** A node that registers itself, and takes the tickets the control plane signs. */
export const node = Layer.effect(
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
export const needs = Dex.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Proxy.layer, Viewer.layer)),
  Layer.provideMerge(node),
  Layer.provideMerge(Control.layer({ console: true, sso: {} })),
  Layer.provideMerge(Dex.address),
);

/** Signs a page that shows the console's sign-in in with a token. */
export const signInWithToken = (page: Viewer.Page, token: string) =>
  Effect.gen(function* () {
    yield* page.until(`!!document.querySelector("[data-console-sign-in-way]")`);
    yield* page.click("[data-console-sign-in-way]");
    yield* page.until(`!!document.querySelector('[data-console-sign-in="token"] input')`);
    yield* page.click("[data-console-sign-in] input");
    yield* page.type(token);
    yield* page.key("Enter", "Enter", ENTER);
  });

/** An account with a session on the node, once the proxy sends what is asked of it on. */
export const withSession = (name: string) =>
  Effect.gen(function* () {
    const proxy = yield* Proxy.Proxy;
    const account = yield* Control.account(name);
    const created = yield* until(
      "a session on the node that registered",
      account.api.sessions.create({ payload: {} }),
      "30 seconds",
    );
    const path = created.path ?? "";
    // The proxy learns of the node when it next asks for its routes.
    yield* until(
      "the proxy sending the request on to the node",
      request(proxy.url, account.token, "GET", `${path}/targets`).pipe(
        Effect.map((answered) => answered.status === 200),
      ),
      "30 seconds",
    );
    return { account, path };
  });
