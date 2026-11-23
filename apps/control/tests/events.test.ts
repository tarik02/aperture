import type { Caller } from "@aperture-browser/control-api";
import { request } from "@aperture-browser/e2e/src/http.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EventsForgetting from "../src/events/forgetting.ts";
import * as EventsLive from "../src/events/layer.ts";
import { Events } from "../src/events/service.ts";
import * as Control from "./src/control.ts";
import { NODE, registered } from "./src/node.ts";
import { signedIn } from "./src/person.ts";
import * as Stores from "./src/stores.ts";

const SILENT_AFTER = "3 seconds";

const needs = registered.pipe(Layer.provideMerge(Control.layer({ nodeSilentAfter: SILENT_AFTER })));

/** What a check reads of an event: what was done, by whom, to what. */
const said = (event: {
  readonly kind: string;
  readonly actor: { readonly kind: string; readonly name: string | null };
  readonly resource: { readonly kind: string; readonly label: string | null } | null;
}) => [event.kind, event.actor.name ?? event.actor.kind, event.resource?.label ?? null];

suite(needs)("the event log", (it) => {
  it.effect("what is done to accounts and their tokens is recorded, by whom and to what", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const root = yield* Control.account(`Root`, true);
      const made = yield* root.api.accounts.create({ payload: { name: "Bot" } });
      const whose = { params: { id: made.id } };
      const token = yield* root.api.accounts.createToken({
        ...whose,
        payload: { name: "ci", scopes: ["sessions:read"], expiresInDays: 1 },
      });
      yield* root.api.accounts.revokeToken({ params: { id: token.id } });
      yield* root.api.accounts.disable(whose);
      yield* root.api.accounts.enable(whose);
      yield* root.api.accounts.remove(whose);

      const { events } = yield* bootstrap.events.list({ query: { actor: root.account.id } });
      expect(events.map(said)).toEqual([
        ["account.removed", root.account.name, "Bot"],
        ["account.enabled", root.account.name, "Bot"],
        ["account.disabled", root.account.name, "Bot"],
        ["token.revoked", root.account.name, "ci"],
        ["token.created", root.account.name, "ci"],
        ["account.created", root.account.name, "Bot"],
      ]);
      const [, , , , created] = events;
      expect(created).toMatchObject({
        actor: { kind: "account", id: root.account.id },
        resource: { kind: "token", id: token.id },
        workspaceId: null,
        address: "127.0.0.1",
        detail: { account: "Bot", scopes: ["sessions:read"], heldToResources: false },
      });
      // Whoever holds the bootstrap token is no account, and is told apart from one.
      const first = yield* bootstrap.events.list({
        query: { resourceKind: "account", resourceId: root.account.id },
      });
      expect(first.events.map((event) => [event.kind, event.actor.kind])).toEqual([
        ["account.created", "bootstrap"],
      ]);
      // No secret is in what is kept of any of it.
      const all = yield* bootstrap.events.list({ query: { limit: 200 } });
      expect(JSON.stringify(all.events)).not.toContain(token.token);
      expect(JSON.stringify(all.events)).not.toContain(root.token);
    }),
  );

  it.effect("an admin reads everything, and anyone else their own and their workspaces'", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const ada = yield* Control.account(`Ada`);
      const bob = yield* Control.account(`Bob`);
      const eve = yield* Control.account(`Eve`);
      const team = yield* ada.api.workspaces.create({ payload: { name: "Team" } });
      const at = { id: team.id };
      yield* ada.api.workspaces.admit({
        params: { ...at, accountId: bob.account.id },
        payload: { role: "member" },
      });
      yield* ada.api.workspaces.rename({ params: at, payload: { name: "The team" } });
      const own = yield* ada.api.workspaces.create({ payload: { name: "Ada's alone" } });

      const kinds = (events: ReadonlyArray<{ readonly kind: string }>) =>
        events.map((event) => event.kind);
      // Ada did all of it, and reads what was done to her account before.
      expect(kinds((yield* ada.api.events.list({ query: {} })).events)).toEqual([
        "workspace.created",
        "workspace.renamed",
        "workspace.member_admitted",
        "workspace.created",
        "token.created",
        "account.created",
      ]);
      // Bob reads what was done in the workspace he is in, and what was done to his
      // account: that it was made, and its token. Nothing of the workspace he is not in.
      const bobs = (yield* bob.api.events.list({ query: {} })).events;
      expect(bobs.map(said)).toEqual([
        ["workspace.renamed", ada.account.name, "The team"],
        ["workspace.member_admitted", ada.account.name, "Team"],
        ["workspace.created", ada.account.name, "Team"],
        ["token.created", "bootstrap", "checks"],
        ["account.created", "bootstrap", bob.account.name],
      ]);
      expect(bobs.some((event) => event.resource?.id === own.id)).toBe(false);
      expect(bobs[1]?.detail).toMatchObject({ accountId: bob.account.id, role: "member" });
      // Eve reads her own alone, and an admin all of it.
      expect(kinds((yield* eve.api.events.list({ query: {} })).events)).toEqual([
        "token.created",
        "account.created",
      ]);
      const everything = yield* bootstrap.events.list({ query: { workspaceId: own.id } });
      expect(kinds(everything.events)).toEqual(["workspace.created"]);

      // A token reads events where it is for that, and of the resources it is held to.
      const scoped = yield* ada.api.accounts.createOwnToken({
        payload: { name: "no events", scopes: ["sessions:write"] },
      });
      const without = yield* control.as(scoped.token);
      expect((yield* Effect.flip(without.events.list({ query: {} })))._tag).toBe("Forbidden");
      const held = yield* ada.api.accounts.createOwnToken({
        payload: {
          name: "the team's events",
          scopes: ["events:read"],
          resources: { workspaces: [team.id], sessions: [], snapshots: [] },
        },
      });
      const holding = yield* control.as(held.token);
      const reached = (yield* holding.events.list({ query: {} })).events;
      expect(reached.length).toBe(3);
      expect(reached.every((event) => event.workspaceId === team.id)).toBe(true);
      // An admin's token that is held to less than an admin's reads as its account does.
      const root = yield* Control.account(`Root-of-events`, true);
      const lesser = yield* root.api.accounts.createOwnToken({
        payload: { name: "events alone", scopes: ["events:read"] },
      });
      const asLesser = yield* control.as(lesser.token);
      const theirs = (yield* asLesser.events.list({ query: { limit: 200 } })).events;
      expect(theirs.length).toBeGreaterThan(0);
      expect(
        theirs.every(
          (event) =>
            event.actor.id === root.account.id ||
            (event.resource !== null &&
              [root.account.name, "checks", "events alone"].includes(event.resource.label ?? "")),
        ),
      ).toBe(true);
    }),
  );

  it.effect("events are told a page at a time, the newest first, and found by what is asked", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const pat = yield* Control.account(`Pat`);
      const names = ["one", "two", "three", "four", "five"];
      const from = DateTime.fromDateUnsafe(new Date());
      for (const name of names) {
        yield* pat.api.accounts.createOwnToken({ payload: { name, scopes: ["events:read"] } });
      }
      const mine = { actor: pat.account.id, kind: "token.created" } as const;
      const walked: Array<string | null> = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = yield* bootstrap.events.list({
          query: { ...mine, limit: 2, ...(cursor === undefined ? {} : { cursor }) },
        });
        walked.push(...page.events.map((event) => event.resource?.label ?? null));
        cursor = page.next ?? undefined;
        pages += 1;
      } while (cursor !== undefined);
      expect(walked).toEqual(names.toReversed());
      expect(pages).toBe(3);

      // By a part of what the actor was called, whatever its case.
      const byName = yield* bootstrap.events.list({
        query: { actor: pat.account.name.toUpperCase().slice(1), kind: "token.created" },
      });
      expect(byName.events.length).toBe(names.length);
      // What `LIKE` reads as anything is read as itself.
      expect((yield* bootstrap.events.list({ query: { actor: "%" } })).events).toEqual([]);
      const since = yield* bootstrap.events.list({ query: { ...mine, since: from } });
      expect(since.events.length).toBe(names.length);
      const until = yield* bootstrap.events.list({ query: { ...mine, until: from } });
      expect(until.events).toEqual([]);

      const refused = (query: string) =>
        control
          .request(control.bootstrapToken, "GET", `/api/control/events?${query}`)
          .pipe(Effect.map((answer) => answer.status));
      expect(yield* refused("limit=2")).toBe(200);
      expect(yield* refused("cursor=nope")).toBe(400);
      expect(yield* refused("kind=nothing.done")).toBe(400);
      expect(yield* refused("limit=0")).toBe(400);
    }),
  );

  it.effect("who signed in is recorded, and who did not, with never what they tried", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const http = yield* HttpClient.HttpClient;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const email = `joan@example.test`;
      const joan = yield* signedIn("Joan", email);
      const wrong = "not the password of anyone";
      const tried = yield* http.execute(
        HttpClientRequest.post(`${control.url}/api/auth/sign-in/email`).pipe(
          HttpClientRequest.setHeader("origin", control.url),
          HttpClientRequest.bodyJsonUnsafe({ email, password: wrong }),
        ),
      );
      expect(tried.status).toBe(401);

      const succeeded = yield* bootstrap.events.list({ query: { kind: "sign_in.succeeded" } });
      expect(succeeded.events[0]).toMatchObject({
        actor: { kind: "account", id: joan.account.id, name: "Joan" },
        resource: { kind: "account", id: joan.account.id },
        address: "127.0.0.1",
        detail: { method: "password" },
      });
      const failed = yield* bootstrap.events.list({ query: { kind: "sign_in.failed" } });
      expect(failed.events[0]).toMatchObject({
        actor: { kind: "anonymous", id: null, name: email },
        resource: null,
        detail: { method: "password", reason: "invalid_email_or_password" },
      });
      const all = JSON.stringify([...succeeded.events, ...failed.events]);
      expect(all).not.toContain(wrong);
      expect(all).not.toContain(joan.password);
      // Their own sign-ins are theirs to read, as whoever their cookies sign in.
      const own = yield* http.execute(
        HttpClientRequest.get(`${control.url}/api/control/events?kind=sign_in.succeeded`).pipe(
          HttpClientRequest.setHeader("cookie", joan.cookie),
        ),
      );
      expect(own.status).toBe(200);
    }),
  );

  it.effect(
    "what is done with sessions, snapshots and share links is recorded, and a guest's joining",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const kim = yield* Control.account(`Kim`);
        const team = yield* kim.api.workspaces.create({ payload: { name: "Kim's team" } });
        const created = yield* until(
          "a session on the node that registered",
          kim.api.sessions.create({ payload: { label: "Recorded", workspaceId: team.id } }),
          "30 seconds",
        );
        const at = { params: { id: created.id } };
        yield* until(
          "the session running",
          kim.api.sessions.get(at).pipe(Effect.map((seen) => seen.observedState === "running")),
          "60 seconds",
        );
        const first = yield* kim.api.snapshots.take({ ...at, payload: { name: "Before" } });
        const second = yield* kim.api.snapshots.take({
          ...at,
          payload: { name: "After", replaces: first.id },
        });
        const link = yield* kim.api.shares.create({
          ...at,
          payload: { name: "For a guest", role: "watch" },
        });
        const { pathname, hash } = new URL(link.url);
        const joined = yield* request(
          control.url,
          "",
          "POST",
          `/api/control/share/${pathname.split("/").at(-1) ?? ""}`,
          { token: hash.slice(1), name: "Grace" },
        );
        expect(joined.status).toBe(200);
        yield* kim.api.shares.revoke({ params: { id: created.id, shareId: link.id } });
        yield* kim.api.sessions.suspend(at);
        yield* kim.api.sessions.resume(at);
        yield* kim.api.snapshots.delete({ params: { id: second.id } });
        yield* kim.api.sessions.delete(at);

        const { events } = yield* kim.api.events.list({ query: { workspaceId: team.id } });
        expect(events.map(said)).toEqual([
          ["session.deleted", kim.account.name, "Recorded"],
          ["snapshot.deleted", kim.account.name, "After"],
          ["session.resumed", kim.account.name, "Recorded"],
          ["session.suspended", kim.account.name, "Recorded"],
          ["share.revoked", kim.account.name, "For a guest"],
          ["share.joined", "Grace", "For a guest"],
          ["share.created", kim.account.name, "For a guest"],
          ["snapshot.replaced", kim.account.name, "Before"],
          ["snapshot.taken", kim.account.name, "After"],
          ["snapshot.taken", kim.account.name, "Before"],
          ["session.created", kim.account.name, "Recorded"],
          ["workspace.created", kim.account.name, "Kim's team"],
        ]);
        const guest = events.find((event) => event.kind === "share.joined");
        expect(guest).toMatchObject({
          actor: { kind: "guest", id: `share:${link.id}`, name: "Grace" },
          detail: { sessionId: created.id, role: "watch" },
        });
        expect(JSON.stringify(events)).not.toContain(hash.slice(1));
        // A token held to the session reads what is about the session, and no more.
        const held = yield* kim.api.accounts.createOwnToken({
          payload: {
            name: "one session's events",
            scopes: ["events:read"],
            resources: { workspaces: [], sessions: [created.id], snapshots: [] },
          },
        });
        const holding = yield* control.as(held.token);
        expect(
          (yield* holding.events.list({ query: {} })).events.map((event) => event.kind),
        ).toEqual(["session.deleted", "session.resumed", "session.suspended", "session.created"]);

        const nodes = yield* bootstrap.events.list({ query: { kind: "node.registered" } });
        expect(nodes.events.map(said)).toEqual([["node.registered", "system", NODE]]);
        expect(nodes.events[0]?.detail).toMatchObject({ registrationToken: "checks" });
      }),
  );

  it.effect("a node that falls silent is noted once, and not the one that is heard from", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const token = yield* bootstrap.nodes.createRegistrationToken({
        payload: { name: "ghosts" },
      });
      const answer = yield* control.keepalive({
        registrationToken: token.token,
        name: "ghost",
        internalUrl: "http://127.0.0.1:9",
        operatorToken: "a token of nothing",
      });
      expect(answer.status).toBe(200);
      const silent = bootstrap.events
        .list({ query: { kind: "node.silent" } })
        .pipe(Effect.map(({ events }) => events.map((event) => event.resource?.label)));
      yield* until(
        "the node that said nothing more being noted silent",
        silent.pipe(Effect.map((nodes) => nodes.includes("ghost"))),
        "20 seconds",
      );
      yield* Effect.sleep("3 seconds");
      expect(yield* silent).toEqual(["ghost"]);
      expect(JSON.stringify(yield* bootstrap.events.list({ query: { limit: 200 } }))).not.toContain(
        "a token of nothing",
      );
    }),
  );
});

const admin: Caller = {
  account: Option.none(),
  admin: true,
  scopes: null,
  resources: null,
  workspaces: [],
};

const kept = EventsLive.layer.pipe(
  Layer.provideMerge(Stores.layer({ APERTURE_CONTROL_EVENTS_KEEP: "2 days" })),
);

suite(kept)("the event log as it is kept", (it) => {
  it.effect("an event is forgotten once it was kept for as long as events are", () =>
    Effect.gen(function* () {
      const events = yield* Events;
      const recorded = events
        .list(admin, {})
        .pipe(Effect.map((page) => page.events.map((event) => event.resource?.label)));
      yield* events.record({
        kind: "workspace.created",
        resource: { kind: "workspace", id: "one", label: "Old" },
      });
      yield* Stores.hours(24);
      yield* events.record({
        kind: "workspace.created",
        resource: { kind: "workspace", id: "two", label: "New" },
      });
      yield* Stores.hours(23);
      expect(yield* recorded).toEqual(["New", "Old"]);
      yield* Stores.hours(2);
      expect(yield* recorded).toEqual(["New"]);
    }).pipe(Effect.provide(Stores.forgetting(Events, EventsForgetting.layer))),
  );
});
