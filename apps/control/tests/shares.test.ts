import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Tickets from "@aperture-browser/e2e/src/tickets.ts";
import { happens, until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import { registered } from "./src/node.ts";
import { cookiesOf } from "./src/person.ts";
import * as Proxy from "./src/proxy.ts";

const needs = Proxy.layer.pipe(Layer.provideMerge(registered), Layer.provideMerge(Control.layer()));

const Told = Schema.Struct({
  sessionId: Schema.String,
  path: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  role: Schema.String,
  tab: Schema.NullOr(Schema.Number),
  name: Schema.String,
});

/** A share link as a guest holds it: where it is asked about, and its secret. */
const linkOf = (url: string) => {
  const { pathname, hash } = new URL(url);
  return { id: pathname.split("/").at(-1) ?? "", secret: hash.slice(1) };
};

suite(needs)("share links into a session", (it) => {
  let ada: Effect.Success<ReturnType<typeof Control.account>>;
  let session = "";
  let other = "";
  let path = "";
  let watching = { id: "", secret: "" };
  let controlling = { id: "", secret: "" };

  /** A request through the proxy as a browser makes it, with the cookies it carries. */
  const browse = Effect.fn(function* (
    method: HttpMethod.HttpMethod,
    at: string,
    cookie: string,
    body?: unknown,
  ) {
    const proxy = yield* Proxy.Proxy;
    const http = yield* HttpClient.HttpClient;
    const answer = yield* http.execute(
      HttpClientRequest.make(method)(`${proxy.url}${at}`).pipe(
        // A page says where it is of, which is where its cookies are taken from.
        HttpClientRequest.setHeaders({ cookie, origin: proxy.url }),
        body === undefined ? (bare) => bare : HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );
    return {
      status: answer.status,
      body: yield* Effect.orElseSucceed(answer.json, () => null),
      cookie: cookiesOf(answer),
      set: answer.headers["set-cookie"] ?? "",
    };
  });

  /** Comes with a link as a guest's page does, and chooses a name after: the cookies of that. */
  const enter = Effect.fn(function* (link: { id: string; secret: string }, name: string) {
    const asked = `/api/control/share/${link.id}`;
    const first = yield* browse("POST", asked, "", { token: link.secret });
    expect(first.status).toBe(200);
    const named = yield* browse("POST", asked, first.cookie, { name });
    expect(named.status).toBe(200);
    return { cookie: named.cookie, told: yield* Schema.decodeUnknownEffect(Told)(named.body) };
  });

  /** The ticket the proxy is given for a guest's request to a path, as it asks for one. */
  const ticketFor = Effect.fn(function* (cookie: string, uri: string, from?: string) {
    const control = yield* Control.Control;
    const http = yield* HttpClient.HttpClient;
    const answer = yield* http.execute(
      HttpClientRequest.get(`${control.url}/api/control/route/admit`).pipe(
        // A browser says where a socket is opened from: the page the guest has open.
        HttpClientRequest.setHeaders({
          cookie,
          origin: from ?? control.url,
          "x-forwarded-uri": uri,
        }),
      ),
    );
    return {
      status: answer.status,
      ticket: (answer.headers["authorization"] ?? "").replace(/^Bearer /u, ""),
    };
  });

  it.effect("whoever has a session makes links into it, each told once and kept as a digest", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      ada = yield* Control.account("Ada");
      const made = yield* ada.api.sessions.create({ payload: {} });
      session = made.id;
      path = made.path ?? "";
      other = (yield* ada.api.sessions.create({ payload: {} })).id;
      yield* until(
        "both sessions running",
        ada.api.sessions
          .list({ query: {} })
          .pipe(Effect.map((all) => all.every((one) => one.observedState === "running"))),
        "60 seconds",
      );

      const watch = yield* ada.api.shares.create({
        params: { id: session },
        payload: { name: "For the review", role: "watch" },
      });
      const drive = yield* ada.api.shares.create({
        params: { id: session },
        payload: { name: "For Grace", role: "control", expiresInHours: 1 },
      });
      watching = linkOf(watch.url);
      controlling = linkOf(drive.url);
      expect(watch.url).toMatch(new RegExp(`^${control.url}/share/${watch.id}#aps_`, "u"));
      expect(watch.expiresAt).toBeNull();
      expect(drive.expiresAt).not.toBeNull();

      const listed = yield* ada.api.shares.list({ params: { id: session } });
      expect(listed.map(({ name, role, lastUsedAt }) => ({ name, role, lastUsedAt }))).toEqual([
        { name: "For the review", role: "watch", lastUsedAt: null },
        { name: "For Grace", role: "control", lastUsedAt: null },
      ]);
      expect(JSON.stringify(listed)).not.toContain(watching.secret);
      expect(yield* ada.api.shares.list({ params: { id: other } })).toEqual([]);

      const kept = yield* control.sql<{
        token_hash: string;
      }>`SELECT token_hash FROM session_shares`;
      expect(kept).toHaveLength(2);
      expect(kept.map((row) => row.token_hash)).not.toContain(watching.secret);
    }),
  );

  it.effect("links are their session's owner's to make, see and take back, and nobody else's", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const bob = yield* Control.account("Bob");
      const params = { id: session };
      expect(
        (yield* Effect.flip(
          bob.api.shares.create({ params, payload: { name: "Mine", role: "control" } }),
        ))._tag,
      ).toBe("SessionNotFound");
      expect((yield* Effect.flip(bob.api.shares.list({ params })))._tag).toBe("SessionNotFound");
      expect(
        (yield* Effect.flip(bob.api.shares.revoke({ params: { ...params, shareId: watching.id } })))
          ._tag,
      ).toBe("SessionNotFound");
      // A link is taken back at its own session, and at no other of the same owner.
      expect(
        (yield* Effect.flip(ada.api.shares.revoke({ params: { id: other, shareId: watching.id } })))
          ._tag,
      ).toBe("ShareNotFound");

      // A token that only reads sessions sees the links, and makes none.
      const bootstrap = yield* control.as(control.bootstrapToken);
      const reading = yield* bootstrap.accounts.createToken({
        params: { id: ada.account.id },
        payload: { name: "reads", scopes: ["sessions:read"] },
      });
      const asReader = yield* control.as(reading.token);
      expect(yield* asReader.shares.list({ params })).toHaveLength(2);
      expect(
        (yield* Effect.flip(
          asReader.shares.create({ params, payload: { name: "No", role: "watch" } }),
        ))._tag,
      ).toBe("Forbidden");
    }),
  );

  it.effect(
    "a guest comes with the link alone, is let in at once, and the browser carries it to the session alone",
    () =>
      Effect.gen(function* () {
        const asked = `/api/control/share/${watching.id}`;
        // Nobody is asked for a name: the guest is called whom the link is for.
        const first = yield* browse("POST", asked, "", { token: watching.secret });
        expect(yield* Schema.decodeUnknownEffect(Told)(first.body)).toEqual({
          sessionId: session,
          path,
          running: true,
          role: "watch",
          tab: null,
          name: "For the review",
        });
        expect(first.cookie).toMatch(/^aperture_share_link=/u);
        expect(first.set).toContain(`Path=${asked}`);
        expect(first.set).toContain("HttpOnly");
        expect(first.set).toContain("SameSite=Strict");
        expect(first.set).toContain(`Path=${path}`);
        expect(first.cookie).toContain("aperture_share=");
        // A link that names nobody calls each of its guests a guest of their own.
        const unnamed = yield* ada.api.shares.create({
          params: { id: session },
          payload: { role: "watch" },
        });
        expect(unnamed.name).toBeNull();
        const someone = yield* browse("POST", `/api/control/share/${unnamed.id}`, "", {
          token: linkOf(unnamed.url).secret,
        });
        const another = yield* browse("POST", `/api/control/share/${unnamed.id}`, "", {
          token: linkOf(unnamed.url).secret,
        });
        const names = yield* Effect.forEach([someone, another], (one) =>
          Schema.decodeUnknownEffect(Told)(one.body).pipe(Effect.map((told) => told.name)),
        );
        expect(names[0]).toMatch(/^Guest [0-9a-f]{4}$/u);
        expect(names[1]).toMatch(/^Guest [0-9a-f]{4}$/u);
        yield* ada.api.shares.revoke({ params: { id: session, shareId: unnamed.id } });

        // A name is one line, and not much of it.
        const named = yield* browse("POST", asked, first.cookie, {
          name: `  Grace\u0000\n Hopper ${"x".repeat(80)} `,
        });
        const told = yield* Schema.decodeUnknownEffect(Told)(named.body);
        expect(told.name).toBe(`Grace Hopper ${"x".repeat(27)}`);
        expect(named.set).toContain(`Path=${path}`);
        // Asked again with what the browser carries, as when the page is shown again.
        const again = yield* browse("POST", asked, named.cookie, {});
        expect(yield* Schema.decodeUnknownEffect(Told)(again.body)).toMatchObject({
          name: told.name,
          path,
        });

        // What is no link is told so, whatever it is asked at.
        expect((yield* browse("POST", asked, "", { token: "aps_not-a-link" })).status).toBe(401);
        expect((yield* browse("POST", asked, "", {})).status).toBe(401);
        const elsewhere = `/api/control/share/${controlling.id}`;
        expect((yield* browse("POST", elsewhere, "", { token: watching.secret })).status).toBe(401);

        const used = yield* ada.api.shares.list({ params: { id: session } });
        expect(used.find((one) => one.id === watching.id)?.lastUsedAt).not.toBeNull();
        expect(used.find((one) => one.id === controlling.id)?.lastUsedAt).toBeNull();
      }),
  );

  it.effect(
    "a guest who may only watch reaches the session through the proxy, and does nothing else there",
    () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const guest = yield* enter(watching, "Grace");
        expect((yield* browse("GET", `${path}/targets`, guest.cookie)).status).toBe(200);
        expect((yield* browse("GET", `${path}/targets`, "")).status).toBe(401);
        for (const [method, rest] of [
          ["PUT", "/proxy"],
          ["POST", "/mcp"],
          ["GET", "/cdp/json/version"],
          ["GET", "/uploads"],
          ["GET", "/downloads"],
          ["GET", "/recordings"],
          ["POST", "/screenshots"],
          ["GET", "/tunnel"],
        ] as const) {
          const answer = yield* browse(method, `${path}${rest}`, guest.cookie, {});
          expect(answer.status, `${method} ${rest}`).toBe(403);
        }

        // A guest's cookie is taken from the guest's own page, and from no page of elsewhere;
        // whoever carries none is let in by nothing, wherever they say they are.
        const foreign = yield* ticketFor(guest.cookie, `${path}/ws`, "https://elsewhere.example");
        expect([foreign.status, foreign.ticket]).toEqual([403, ""]);
        expect((yield* ticketFor("", `${path}/ws`, "https://elsewhere.example")).status).toBe(401);
        const { ticket } = yield* ticketFor(guest.cookie, `${path}/ws`);
        const member = yield* Tickets.join({ url: `${executor.url}/sessions/${session}` }, ticket);
        expect(yield* member.self).toMatchObject({ name: "Grace", role: "ROLE_VIEW" });
        const features = yield* Schema.decodeUnknownEffect(Tickets.Features)(
          member.seen["features"],
        );
        expect(features.input?.write ?? false).toBe(false);
        expect(features.clipboard?.read ?? false).toBe(false);
        // What it asks of the session beyond watching is refused there.
        yield* member.send({ go: { url: "", newTab: true } });
        yield* until(
          "the session refusing what a watcher asked",
          Effect.sync(() => member.failures.length > 0),
        );
      }),
  );

  it.effect(
    "a guest who may control gives input and takes tabs, and still has none of its files or automation",
    () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const guest = yield* enter(controlling, "Linus");
        expect(guest.told.role).toBe("control");
        expect((yield* browse("GET", `${path}/targets`, guest.cookie)).status).toBe(200);
        for (const [method, rest] of [
          ["PUT", "/proxy"],
          ["POST", "/mcp"],
          ["GET", "/cdp/json/version"],
          ["GET", "/uploads"],
          ["GET", "/downloads"],
          ["GET", "/recordings"],
          ["GET", "/tunnel"],
        ] as const) {
          const answer = yield* browse(method, `${path}${rest}`, guest.cookie, {});
          expect(answer.status, `${method} ${rest}`).toBe(403);
        }

        const { ticket } = yield* ticketFor(guest.cookie, `${path}/ws`);
        const member = yield* Tickets.join({ url: `${executor.url}/sessions/${session}` }, ticket);
        expect(yield* member.self).toMatchObject({ name: "Linus", role: "ROLE_ADMIN" });
        const features = yield* Schema.decodeUnknownEffect(Tickets.Features)(
          member.seen["features"],
        );
        expect(features.input?.write).toBe(true);
        expect(features.tabs?.write).toBe(true);
        expect(features.uploads?.write ?? false).toBe(false);
        expect(features.recordings?.read ?? false).toBe(false);
        expect(features.cdp?.write ?? false).toBe(false);
        yield* member.send({ go: { url: "", newTab: true } });
        expect(
          yield* happens(
            Effect.sync(() => member.failures.length > 0),
            "2 seconds",
          ),
        ).toBe(false);
      }),
  );

  it.effect(
    "a link to one tab shows that tab alone: no other is told of, gone to, opened or seen",
    () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const at = { url: `${executor.url}/sessions/${session}` };
        // A tab's number is left out where it is naught, as the protocol's JSON leaves any.
        const Tabs = Schema.Struct({
          targets: Schema.optional(
            Schema.Struct({
              targets: Schema.optional(
                Schema.Array(Schema.Struct({ tab: Schema.optional(Schema.Number) })),
              ),
            }),
          ),
          selected: Schema.optional(Schema.Struct({ tab: Schema.optional(Schema.Number) })),
        });
        // What the member was told last, each time it is looked at.
        const tabsOf = (member: Tickets.Member) =>
          Effect.suspend(() => Schema.decodeUnknownEffect(Tabs)(member.seen)).pipe(
            Effect.map((seen) => ({
              tabs: (seen.targets?.targets ?? []).map((target) => target.tab ?? 0),
              selected: seen.selected?.tab,
            })),
          );
        // The owner opens a tab beside the one there is, and watches it.
        const owner = yield* Tickets.join(
          at,
          (yield* ticketFor(`aperture_control=${ada.token}`, `${path}/ws`)).ticket,
        );
        const before = (yield* tabsOf(owner)).tabs;
        yield* owner.send({ go: { url: "", newTab: true } });
        const shown = yield* until(
          "the owner watching the tab they opened",
          tabsOf(owner).pipe(
            Effect.map(({ tabs, selected }) =>
              tabs.length > before.length && selected !== undefined && !before.includes(selected)
                ? selected
                : undefined,
            ),
          ),
        );
        const other = before[0] ?? -1;

        const made = yield* ada.api.shares.create({
          params: { id: session },
          payload: { role: "control", tab: shown },
        });
        expect(made.tab).toBe(shown);
        const guest = yield* enter(linkOf(made.url), "Ada's guest");
        expect(guest.told.tab).toBe(shown);
        const member = yield* Tickets.join(
          at,
          (yield* ticketFor(guest.cookie, `${path}/ws`)).ticket,
        );
        expect(yield* tabsOf(member)).toEqual({ tabs: [shown], selected: shown });

        // Asked for another tab, it stays where it is; a new one is not its to open.
        yield* member.send({ select: { tab: other } });
        yield* member.send({ go: { url: "", newTab: true } });
        yield* until(
          "the session refusing a new tab of whoever sees one",
          Effect.sync(() => member.failures.some((failure) => failure.asked === "ASKED_GO")),
        );
        expect(
          yield* happens(
            tabsOf(member).pipe(Effect.map(({ selected }) => selected !== shown)),
            "2 seconds",
          ),
        ).toBe(false);
        expect((yield* tabsOf(member)).tabs).toEqual([shown]);

        // Nothing at the session's routes shows another tab, or tells of them all.
        for (const rest of [
          `/previews/${other}`,
          `/previews/${other}/favicon`,
          `/targets/${other}/preview.png`,
          `/targets/${other}/screenshot.png`,
          "/previews",
          "/preview.png",
          "/targets",
        ]) {
          const answer = yield* browse("GET", `${path}${rest}`, guest.cookie);
          expect(answer.status, rest).toBe(403);
        }
        expect(
          (yield* browse("GET", `${path}/targets/${shown}/preview.png`, guest.cookie)).status,
        ).not.toBe(403);

        // Its tab closed, it sees nothing: the session's other tab is still not its.
        yield* owner.send({ close: { tab: shown } });
        yield* until(
          "the guest of a tab that was closed seeing nothing",
          tabsOf(member).pipe(
            Effect.map(({ tabs, selected }) => tabs.length === 0 && selected === undefined),
          ),
        );
        yield* ada.api.shares.revoke({ params: { id: session, shareId: made.id } });
      }),
  );

  it.effect("a link lets into its own session, and into nothing else", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const proxy = yield* Proxy.Proxy;
      const guest = yield* enter(controlling, "Linus");
      const share = guest.cookie.split("; ").find((one) => one.startsWith("aperture_share="));
      // Another session of the same owner, were the browser to carry the link there.
      const elsewhere = path.replace(session, other);
      expect((yield* browse("GET", `${elsewhere}/targets`, share ?? "")).status).toBe(401);
      expect((yield* ticketFor(share ?? "", `${elsewhere}/ws`)).status).toBe(401);
      // Nor is its secret a token of the API's, however it is carried.
      for (const base of [control.url, proxy.url]) {
        expect(
          (yield* control.request(controlling.secret, "GET", "/api/control/sessions")).status,
        ).toBe(401);
        const http = yield* HttpClient.HttpClient;
        const carried = yield* http.execute(
          HttpClientRequest.get(`${base}/api/control/sessions`).pipe(
            HttpClientRequest.setHeader(
              "cookie",
              `${guest.cookie}; aperture_control=${controlling.secret}`,
            ),
          ),
        );
        expect(carried.status).toBe(401);
      }
      // The node itself takes no link: only a ticket of the control plane's.
      const executor = yield* Executor.Executor;
      const http = yield* HttpClient.HttpClient;
      const direct = yield* http.execute(
        HttpClientRequest.get(`${executor.url}/sessions/${session}/targets`).pipe(
          HttpClientRequest.bearerToken(controlling.secret),
        ),
      );
      expect(direct.status).toBe(401);
    }),
  );

  it.effect(
    "who is signed in comes as themselves, and a link is for whom that lets into nothing",
    () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const guest = yield* enter(watching, "Grace");
        const bob = yield* Control.account("Bob of the link");
        const asked = `${path}/ws`;
        // The owner's own token beside the link: the owner, with all that is theirs.
        const asOwner = yield* ticketFor(`${guest.cookie}; aperture_control=${ada.token}`, asked);
        const owner = yield* Tickets.join(
          { url: `${executor.url}/sessions/${session}` },
          asOwner.ticket,
        );
        expect(yield* owner.self).toMatchObject({ name: "Ada", role: "ROLE_ADMIN" });
        // Someone else's token reaches nothing there: they come by the link, as its guest.
        const asOther = yield* ticketFor(`${guest.cookie}; aperture_control=${bob.token}`, asked);
        const member = yield* Tickets.join(
          { url: `${executor.url}/sessions/${session}` },
          asOther.ticket,
        );
        expect(yield* member.self).toMatchObject({ name: "Grace", role: "ROLE_VIEW" });
      }),
  );

  it.effect(
    "a link that is taken back lets nobody in, and those who are in by it are put out",
    () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const at = { url: `${executor.url}/sessions/${session}` };
        const grace = yield* enter(watching, "Grace");
        const linus = yield* enter(controlling, "Linus");
        const watcher = yield* Tickets.join(
          at,
          (yield* ticketFor(grace.cookie, `${path}/ws`)).ticket,
        );
        const driver = yield* Tickets.join(
          at,
          (yield* ticketFor(linus.cookie, `${path}/ws`)).ticket,
        );

        yield* ada.api.shares.revoke({ params: { id: session, shareId: watching.id } });
        yield* until(
          "the guest of the link that was taken back being put out",
          Effect.sync(() => watcher.closed()),
        );
        expect((yield* browse("GET", `${path}/targets`, grace.cookie)).status).toBe(401);
        expect(
          (yield* browse("POST", `/api/control/share/${watching.id}`, grace.cookie, {})).status,
        ).toBe(401);
        expect(
          (yield* ada.api.shares.list({ params: { id: session } })).map((one) => one.id),
        ).toEqual([controlling.id]);
        // The other link's guest stays.
        expect(
          yield* happens(
            Effect.sync(() => driver.closed()),
            "1 second",
          ),
        ).toBe(false);
        expect((yield* browse("GET", `${path}/targets`, linus.cookie)).status).toBe(200);
      }),
  );

  it.effect(
    "a link that runs out lets nobody in from then on, and its guests are out when it does",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const linus = yield* enter(controlling, "Linus");
        const { ticket } = yield* ticketFor(linus.cookie, `${path}/ws`);
        // The ticket says when the link ends, which is when the node closes the socket.
        const claims = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ sub: Schema.String, until: Schema.Number })),
        )(yield* Effect.fromResult(Base64Url.decodeString(ticket.split(".")[1] ?? "")));
        expect(claims.sub).toBe(`share:${controlling.id}`);
        const [left] = (yield* ada.api.shares.list({ params: { id: session } })).filter(
          (one) => one.id === controlling.id,
        );
        expect(claims.until).toBe(Math.floor((left?.expiresAt?.epochMilliseconds ?? 0) / 1000));

        // Its hour is over: the database is told so in the clock's place.
        yield* control.sql`UPDATE session_shares SET expires_at = now() - interval '1 second'`;
        expect((yield* browse("GET", `${path}/targets`, linus.cookie)).status).toBe(401);
        expect(
          (yield* browse("POST", `/api/control/share/${controlling.id}`, linus.cookie, {})).status,
        ).toBe(401);
        // It is still listed, for its owner to see that it ran out.
        expect(yield* ada.api.shares.list({ params: { id: session } })).toHaveLength(1);
      }),
  );

  it.effect(
    "the links of an account that is disabled let nobody in while it is, and one that is removed takes them with it; their guests are put out",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const executor = yield* Executor.Executor;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const at = { url: `${executor.url}/sessions/${session}` };
        // An admin reaches the session, and so makes a link into it that is their own.
        const root = yield* Control.account(`Root-of-links`, true);
        // The last admin stays, so there is another beside them.
        yield* Control.account(`Another-admin`, true);
        const made = yield* root.api.shares.create({
          params: { id: session },
          payload: { name: "An admin's", role: "watch" },
        });
        const link = linkOf(made.url);
        const whose = { params: { id: root.account.id } };
        const asked = `/api/control/share/${link.id}`;

        const grace = yield* enter(link, "Grace");
        const first = yield* Tickets.join(
          at,
          (yield* ticketFor(grace.cookie, `${path}/ws`)).ticket,
        );
        yield* bootstrap.accounts.disable(whose);
        yield* until(
          "the guest of a disabled account's link being put out",
          Effect.sync(() => first.closed()),
        );
        expect((yield* browse("GET", `${path}/targets`, grace.cookie)).status).toBe(401);
        expect((yield* browse("POST", asked, grace.cookie, {})).status).toBe(401);
        expect((yield* ticketFor(grace.cookie, `${path}/ws`)).status).toBe(401);

        // In use again, the account's links are as they were.
        yield* bootstrap.accounts.enable(whose);
        expect((yield* browse("POST", asked, grace.cookie, {})).status).toBe(200);
        const again = yield* Tickets.join(
          at,
          (yield* ticketFor(grace.cookie, `${path}/ws`)).ticket,
        );
        yield* bootstrap.accounts.remove(whose);
        yield* until(
          "the guest of a removed account's link being put out",
          Effect.sync(() => again.closed()),
        );
        expect((yield* browse("GET", `${path}/targets`, grace.cookie)).status).toBe(401);
        expect(
          (yield* ada.api.shares.list({ params: { id: session } })).map((one) => one.id),
        ).not.toContain(link.id);
      }),
  );

  it.effect("a session that is deleted takes its links with it", () =>
    Effect.gen(function* () {
      const made = yield* ada.api.shares.create({
        params: { id: other },
        payload: { name: "Short-lived", role: "watch" },
      });
      const link = linkOf(made.url);
      const guest = yield* enter(link, "Grace");
      const there = guest.told.path ?? "";
      expect((yield* browse("GET", `${there}/targets`, guest.cookie)).status).toBe(200);
      yield* ada.api.sessions.delete({ params: { id: other } });
      expect((yield* browse("GET", `${there}/targets`, guest.cookie)).status).toBe(401);
      expect(
        (yield* browse("POST", `/api/control/share/${link.id}`, guest.cookie, {})).status,
      ).toBe(401);
      // The session and its link are kept, as is a link that was taken back: marked, and
      // in nothing that is read.
      const { sql } = yield* Control.Control;
      expect(
        yield* sql`
          SELECT id::text FROM session_shares
          WHERE id::text IN (${link.id}, ${watching.id}) AND deleted_at IS NOT NULL
          ORDER BY created_at
        `,
      ).toEqual([{ id: watching.id }, { id: link.id }]);
      expect(
        yield* sql`SELECT deleted_at IS NULL AS live FROM sessions WHERE id = ${other}`,
      ).toEqual([{ live: false }]);
      expect((yield* Effect.flip(ada.api.shares.list({ params: { id: other } })))._tag).toBe(
        "SessionNotFound",
      );
    }),
  );
});
