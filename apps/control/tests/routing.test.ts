import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { follow, read, request } from "@aperture-browser/e2e/src/http.ts";
import * as Mcp from "@aperture-browser/e2e/src/mcp.ts";
import * as Site from "@aperture-browser/e2e/src/site.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import { signedIn } from "./src/person.ts";
import * as Proxy from "./src/proxy.ts";
import { needs } from "./src/console.ts";

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

  it.effect("a page of another origin opens no session with what the browser carries", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const viewer = yield* Viewer.Viewer;
      const http = yield* HttpClient.HttpClient;
      // Another origin of the same site: the browser sends it the cookies all the same.
      const elsewhere = yield* Site.serve(Site.html("<title>elsewhere</title>"));
      const opens = (page: Viewer.Page, route: string) =>
        page.evaluate(
          `new Promise((resolve) => {
            const socket = new WebSocket(${JSON.stringify(`${proxy.url.replace("http", "ws")}${path}${route}`)});
            socket.onopen = () => (socket.close(), resolve(true));
            socket.onerror = () => resolve(false);
          })`,
          Schema.Boolean,
        );
      const foreign = yield* viewer.open(elsewhere.url);
      yield* foreign.until(`document.title === "elsewhere"`);
      expect(yield* opens(foreign, "/ws")).toBe(false);
      expect(yield* opens(foreign, "/cdp")).toBe(false);
      yield* foreign.close;
      const own = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
      yield* own.until(`document.readyState === "complete"`);
      expect(yield* opens(own, "/ws")).toBe(true);
      expect(yield* opens(own, "/cdp")).toBe(true);
      yield* own.close;

      // The same as requests say it, and for the cookie a person signs in with as well.
      const asked = (
        method: "GET" | "PUT",
        route: string,
        headers: Record<string, string>,
        token?: string,
      ) =>
        http
          .execute(
            HttpClientRequest.make(method)(`${proxy.url}${route}`).pipe(
              HttpClientRequest.setHeaders(headers),
              token === undefined ? (bare) => bare : HttpClientRequest.bearerToken(token),
            ),
          )
          .pipe(Effect.map((answer) => answer.status));
      const person = yield* signedIn("Origin of Ada", "origin@example.com");
      const theirs = yield* until(
        "a session of the person's own",
        http
          .execute(
            HttpClientRequest.post(`${proxy.url}/api/control/sessions`).pipe(
              HttpClientRequest.setHeaders({ cookie: person.cookie, origin: proxy.url }),
              HttpClientRequest.bodyJsonUnsafe({}),
            ),
          )
          .pipe(
            Effect.flatMap((answer) => answer.json),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ path: Schema.String }))),
          ),
        "30 seconds",
      );
      for (const [cookie, session] of [
        [`aperture_control=${ada.token}`, path],
        [person.cookie, theirs.path],
      ] as const) {
        const from = (origin: string | undefined) => ({
          cookie,
          ...(origin === undefined ? {} : { origin }),
        });
        const targets = `${session}/targets`;
        yield* until(
          "the session answering its own",
          asked("GET", targets, from(proxy.url)).pipe(Effect.map((status) => status === 200)),
          "60 seconds",
        );
        expect(yield* asked("GET", targets, from(elsewhere.url))).toBe(403);
        expect(yield* asked("GET", targets, from("null"))).toBe(403);
        // What is no page says no origin, and reads; a page says its own whenever it does more.
        expect(yield* asked("GET", targets, from(undefined))).toBe(200);
        expect(yield* asked("PUT", `${session}/proxy`, from(undefined))).toBe(403);
        // A browser says where a socket is opened from, always.
        for (const socket of ["/ws", "/cdp", "/cdp/devtools/page/1", "/tunnel"]) {
          expect(yield* asked("GET", `${session}${socket}`, from(undefined))).toBe(403);
          expect(yield* asked("GET", `${session}${socket}`, from(elsewhere.url))).toBe(403);
          expect(yield* asked("GET", `${session}${socket}`, from(proxy.url))).not.toBe(403);
        }
      }
      // Whoever carries nothing is let in by nothing, and is told that, whatever they say else.
      const foreignly = { origin: elsewhere.url };
      for (const route of ["/targets", "/ws", "/cdp"]) {
        expect(yield* asked("GET", `${path}${route}`, {})).toBe(401);
        expect(yield* asked("GET", `${path}${route}`, foreignly)).toBe(401);
      }
      expect(yield* asked("PUT", `${path}/proxy`, {})).toBe(401);
      // Whoever carries a token or a ticket is let in by that, from wherever.
      expect(yield* asked("GET", `${path}/targets`, foreignly, ada.token)).toBe(200);
      expect(yield* asked("GET", `${path}/ws`, {}, ada.token)).not.toBe(403);
      const { ticket } = yield* ada.api.sessions.createTicket({
        params: { id: path.split("/").at(-1) ?? "" },
        payload: {},
      });
      expect(yield* asked("GET", `${path}/targets?token=${ticket}`, foreignly)).toBe(200);
    }),
  );
});
