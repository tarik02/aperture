import { proto } from "@aperture-browser/executor-client";
import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { request } from "@aperture-browser/e2e/src/http.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Control from "./src/control.ts";

const NODE = "node-a";
const SILENT_AFTER = "3 seconds";
const KEEPALIVE_EVERY = "500 millis";

/** The node's keepalives, which the checks send in the executor's place. */
class Keepalives extends Context.Service<
  Keepalives,
  {
    /** Stops them, as a node that died or lost its way to the control plane. */
    readonly stop: Effect.Effect<void>;
    readonly start: Effect.Effect<void>;
  }
>()("@aperture-browser/control/tests/Keepalives") {}

const node = Layer.effect(
  Executor.Executor,
  Effect.gen(function* () {
    const control = yield* Control.Control;
    return yield* Executor.start({ env: { APERTURE_TICKET_KEY: control.ticketKey } });
  }),
);

const keepalives = Layer.effect(
  Keepalives,
  Effect.gen(function* () {
    const control = yield* Control.Control;
    const executor = yield* Executor.Executor;
    const bootstrap = yield* control.as(control.bootstrapToken);
    const token = yield* bootstrap.nodes.createRegistrationToken({ payload: { name: "checks" } });
    let sending = true;
    yield* Effect.suspend(() =>
      sending
        ? control.keepalive({
            registrationToken: token.token,
            name: NODE,
            internalUrl: executor.url,
            publicUrl: executor.url,
            operatorToken: executor.token,
          })
        : Effect.void,
    ).pipe(Effect.ignore, Effect.repeat(Schedule.spaced(KEEPALIVE_EVERY)), Effect.forkScoped);
    yield* until(
      "the control plane reaching the node",
      bootstrap.nodes
        .list()
        .pipe(Effect.map((nodes) => nodes.some((listed) => listed.offers !== null))),
    );
    return {
      stop: Effect.sync(() => {
        sending = false;
      }),
      start: Effect.sync(() => {
        sending = true;
      }),
    };
  }),
);

const needs = (stores: (typeof Control.STORES)[number]) =>
  keepalives.pipe(
    Layer.provideMerge(node),
    Layer.provideMerge(Control.layer({ stores, nodeSilentAfter: SILENT_AFTER })),
  );

for (const stores of Control.STORES) {
  suite(needs(stores))(`sessions on a node that registered, kept in ${stores}`, (it) => {
    let ada: Effect.Success<ReturnType<typeof Control.account>>;
    let session = "";

    it.effect("a session is created on the node, and its record follows it to running", () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const control = yield* Control.Control;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const [registered] = yield* bootstrap.nodes.list();
        expect(registered).toMatchObject({ name: NODE, alive: true });
        expect(registered?.offers?.version).not.toBe("");

        ada = yield* Control.account("Ada");
        const created = yield* ada.api.sessions.create({ payload: {} });
        session = created.id;
        expect(created).toMatchObject({
          accountId: ada.account.id,
          nodeId: registered?.id,
          desiredState: "running",
          unreachableSince: null,
        });
        expect((yield* executor.client.sessions.get(session)).id).toBe(session);

        yield* until(
          "the record telling the session runs",
          ada.api.sessions
            .get({ params: { id: session } })
            .pipe(Effect.map((seen) => seen.observedState === "running")),
          "60 seconds",
        );
        expect((yield* ada.api.sessions.list()).map((listed) => listed.id)).toEqual([session]);
      }),
    );

    it.effect("a ticket the control plane signs lets its holder into the session", () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const watching = yield* ada.api.sessions.createTicket({
          params: { id: session },
          payload: {},
        });
        expect(watching.url).toBe(`${executor.url}/sessions/${session}/?token=${watching.ticket}`);

        const targets = `/sessions/${session}/targets`;
        expect((yield* request(executor.url, watching.ticket, "GET", targets)).status).toBe(200);
        expect((yield* request(executor.url, "no-ticket", "GET", targets)).status).toBe(401);
        // Watching is all a ticket with no access gives.
        const proxy = `/sessions/${session}/proxy`;
        expect((yield* request(executor.url, watching.ticket, "PUT", proxy, {})).status).toBe(403);

        const routing = yield* ada.api.sessions.createTicket({
          params: { id: session },
          payload: { name: "Ada L.", access: { proxy: "rw" } },
        });
        expect((yield* request(executor.url, routing.ticket, "PUT", proxy, {})).status).not.toBe(
          403,
        );
        // No ticket is the operator's token: the node's other sessions are not its holder's.
        const others = yield* executor.rpc("ListSessions");
        expect(others.status).toBe(200);
        const asTicket = yield* request(
          executor.url,
          routing.ticket,
          "POST",
          "/aperture.executor.v1.ExecutorService/ListSessions",
          {},
        );
        expect(asTicket.status).not.toBe(200);
      }),
    );

    it.effect("another account neither sees nor touches it, and an admin sees it", () =>
      Effect.gen(function* () {
        const eve = yield* Control.account("Eve");
        const at = { params: { id: session } };
        expect(yield* eve.api.sessions.list()).toEqual([]);
        expect((yield* Effect.flip(eve.api.sessions.get(at)))._tag).toBe("SessionNotFound");
        expect((yield* Effect.flip(eve.api.sessions.suspend(at)))._tag).toBe("SessionNotFound");
        expect((yield* Effect.flip(eve.api.sessions.resume(at)))._tag).toBe("SessionNotFound");
        expect((yield* Effect.flip(eve.api.sessions.delete(at)))._tag).toBe("SessionNotFound");
        expect(
          (yield* Effect.flip(eve.api.sessions.createTicket({ ...at, payload: {} })))._tag,
        ).toBe("SessionNotFound");
        expect((yield* ada.api.sessions.get(at)).observedState).toBe("running");

        const root = yield* Control.account("Root", true);
        expect((yield* root.api.sessions.list()).map((listed) => listed.id)).toEqual([session]);
      }),
    );

    it.effect("a snapshot is taken on the session's node, and a session is created from it", () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const taken = yield* ada.api.snapshots.take({
          params: { id: session },
          payload: { name: "signed in" },
        });
        expect(taken).toMatchObject({
          accountId: ada.account.id,
          name: "signed in",
          sessionId: session,
          shared: false,
        });
        expect((yield* executor.client.snapshots.get(taken.id)).id).toBe(taken.id);
        expect((yield* ada.api.snapshots.list()).map((listed) => listed.id)).toEqual([taken.id]);

        const mallory = yield* Control.account("Mallory");
        const at = { params: { id: taken.id } };
        expect(yield* mallory.api.snapshots.list()).toEqual([]);
        expect((yield* Effect.flip(mallory.api.snapshots.get(at)))._tag).toBe("SnapshotNotFound");
        expect((yield* Effect.flip(mallory.api.snapshots.delete(at)))._tag).toBe(
          "SnapshotNotFound",
        );
        const refused = yield* Effect.flip(
          mallory.api.sessions.create({ payload: { snapshotId: taken.id } }),
        );
        expect(refused._tag).toBe("SnapshotNotFound");

        const from = yield* ada.api.sessions.create({
          payload: { snapshotId: taken.id, suspended: true },
        });
        expect(from.snapshotId).toBe(taken.id);
        expect((yield* executor.client.sessions.get(from.id)).snapshotId).toBe(taken.id);
        yield* ada.api.sessions.delete({ params: { id: from.id } });

        // What a session and a snapshot are called and tagged with is their owner's to change.
        const named = yield* ada.api.sessions.describe({
          params: { id: session },
          payload: { label: "Checkout flow", tags: ["shop", "qa"] },
        });
        expect(named).toMatchObject({ label: "Checkout flow", tags: ["shop", "qa"] });
        const retagged = yield* ada.api.sessions.describe({
          params: { id: session },
          payload: { tags: ["shop"] },
        });
        expect(retagged).toMatchObject({ label: "Checkout flow", tags: ["shop"] });
        const described = yield* ada.api.snapshots.describe({
          ...at,
          payload: { description: "After signing in", tags: ["shop"] },
        });
        expect(described).toMatchObject({
          name: "signed in",
          description: "After signing in",
          tags: ["shop"],
        });

        yield* ada.api.snapshots.delete(at);
        expect(yield* ada.api.snapshots.list()).toEqual([]);
        expect((yield* Effect.flip(executor.client.snapshots.get(taken.id))).code).toBe(
          "not_found",
        );
      }),
    );

    it.effect("suspending and resuming go through to the node", () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const at = { params: { id: session } };

        const suspended = yield* ada.api.sessions.suspend(at);
        expect(suspended.desiredState).toBe("suspended");
        yield* until(
          "the record telling the session is suspended",
          ada.api.sessions.get(at).pipe(Effect.map((seen) => seen.observedState === "suspended")),
          "30 seconds",
        );
        expect((yield* executor.client.sessions.get(session)).state).toBe(
          proto.SessionState.SUSPENDED,
        );

        const resumed = yield* ada.api.sessions.resume(at);
        expect(resumed.desiredState).toBe("running");
        yield* until(
          "the record telling the session runs again",
          ada.api.sessions.get(at).pipe(Effect.map((seen) => seen.observedState === "running")),
          "60 seconds",
        );
        expect((yield* executor.client.sessions.get(session)).state).toBe(
          proto.SessionState.RUNNING,
        );
      }),
    );

    it.effect("a node that falls silent gets no session, and the ones it has are kept", () =>
      Effect.gen(function* () {
        const keepalives = yield* Keepalives;
        const at = { params: { id: session } };

        yield* keepalives.stop;
        const marked = yield* until(
          "the session being told as out of reach",
          ada.api.sessions
            .get(at)
            .pipe(Effect.map((seen) => seen.unreachableSince !== null && seen)),
        );
        // What was last seen of it stays.
        expect(marked).toMatchObject({ observedState: "running", desiredState: "running" });
        expect((yield* Effect.flip(ada.api.sessions.create({ payload: {} })))._tag).toBe("NoNode");

        yield* keepalives.start;
        yield* until(
          "the session being in reach again",
          ada.api.sessions.get(at).pipe(Effect.map((seen) => seen.unreachableSince === null)),
        );
      }),
    );

    it.effect("what happens to a session on its node is told in its record", () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const at = { params: { id: session } };
        // Behind the control plane's back, as the node suspends a session that sits idle.
        yield* executor.client.sessions.suspend(session);
        const seen = yield* until(
          "the record telling what the node did",
          ada.api.sessions
            .get(at)
            .pipe(Effect.map((record) => record.observedState === "suspended" && record)),
          "30 seconds",
        );
        // What its owner asked for is another matter than what it is.
        expect(seen.desiredState).toBe("running");
      }),
    );

    it.effect("deleting goes through to the node", () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const at = { params: { id: session } };
        yield* ada.api.sessions.delete(at);
        expect((yield* Effect.flip(ada.api.sessions.get(at)))._tag).toBe("SessionNotFound");
        expect(yield* ada.api.sessions.list()).toEqual([]);
        expect((yield* Effect.flip(executor.client.sessions.get(session))).code).toBe("not_found");
      }),
    );

    it.effect("a session its node has no more is told as gone, and not forgotten", () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const created = yield* ada.api.sessions.create({ payload: { suspended: true } });
        expect(created).toMatchObject({ desiredState: "suspended", observedState: "suspended" });

        yield* executor.client.sessions.delete(created.id);
        const gone = yield* until(
          "the record telling the session is gone",
          ada.api.sessions
            .get({ params: { id: created.id } })
            .pipe(Effect.map((seen) => seen.observedState === "gone" && seen)),
        );
        expect(gone.nodeId).toBeNull();
        const refused = yield* Effect.flip(ada.api.sessions.resume({ params: { id: created.id } }));
        expect(refused._tag).toBe("SessionHasNoNode");
      }),
    );
  });
}
