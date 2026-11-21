import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { request } from "@aperture-browser/e2e/src/http.ts";
import { directory } from "@aperture-browser/e2e/src/process.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import * as Proxy from "./src/proxy.ts";

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
  Layer.provideMerge(Control.layer({ stores: "memory" })),
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
});
