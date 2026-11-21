import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { request } from "@aperture-browser/e2e/src/http.ts";
import { directory, logsDirectory } from "@aperture-browser/e2e/src/process.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import * as Proxy from "./src/proxy.ts";

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
      env: {
        APERTURE_TICKET_KEY: control.ticketKey,
        APERTURE_CONTROL_PLANE: control.url,
        APERTURE_REGISTRATION_TOKEN_FILE: file,
        APERTURE_NODE: "node-behind-the-proxy",
      },
    });
  }),
);

const needs = Layer.mergeAll(Proxy.layer, Viewer.layer).pipe(
  Layer.provideMerge(node),
  Layer.provideMerge(Control.layer({ stores: "memory", console: true })),
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
      yield* page.until(`!!document.querySelector("[data-console-sign-in] input")`);
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

      // A token is made in the page, and told there once.
      yield* page.click(`a[href="/-/tokens"]`);
      yield* page.until(`!!document.querySelector('[data-console-token="checks"]')`);
      yield* page.click("[data-console-token-new]");
      yield* page.until(`!!document.querySelector("[data-console-token-create] input")`);
      yield* page.click("[data-console-token-create] input");
      yield* page.type("from the console");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector("[data-console-secret]")`);
      const secret = (yield* page.text("[data-console-secret]")) ?? "";
      expect(secret).toMatch(/^apc_/u);
      const withIt = yield* (yield* Control.Control).as(secret);
      expect((yield* withIt.accounts.current()).id).toBe(ada.account.id);
      yield* shot(page, fs, "console-token");
      yield* page.key("Escape", "Escape", ESCAPE);

      yield* ada.api.snapshots.take({ params: { id }, payload: { name: "signed in" } });
      yield* page.click(`a[href="/-/snapshots"]`);
      yield* page.until(`!!document.querySelector("[data-console-snapshot]")`);
      yield* shot(page, fs, "console-snapshots");

      yield* page.click(`a[href="/-/sessions"]`);
      yield* page.until(`!!document.querySelector(${JSON.stringify(card)})`);
      yield* page.click(`${card} [data-console-session-open]`);
      yield* page.until(`location.pathname === ${JSON.stringify(`/-/sessions/${id}`)}`);
      // The picture is there once the session's socket, which went through the proxy, is.
      yield* page.until(
        `[...document.querySelectorAll("[data-aperture-surface]")].some((surface) => surface.getBoundingClientRect().width > 0)`,
        "30 seconds",
      );
      yield* shot(page, fs, "console-session");

      // A session is made as it is asked for in the dialog, and opened.
      yield* page.evaluate(`void (location.href = "/-/sessions")`);
      yield* page.until(`!!document.querySelector("[data-console-create-custom]")`);
      yield* page.click("[data-console-create-custom]");
      yield* page.until(`!!document.querySelector("[data-console-session-create] input")`);
      yield* page.click("[data-console-session-create] input");
      yield* page.type("Made in a dialog");
      yield* shot(page, fs, "console-create");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(
        `location.pathname.startsWith("/-/sessions/") && !location.pathname.endsWith(${JSON.stringify(id)})`,
      );
      const made = (yield* ada.api.sessions.list()).find((one) => one.label === "Made in a dialog");
      expect(made).toBeDefined();
      expect(page.errors()).toEqual([]);
    }),
  );
});
