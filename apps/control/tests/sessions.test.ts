import { proto } from "@aperture-browser/executor-client";
import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { request } from "@aperture-browser/e2e/src/http.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Control from "./src/control.ts";
import { Keepalives, NODE, registered } from "./src/node.ts";

const SILENT_AFTER = "3 seconds";

const needs = (stores: (typeof Control.STORES)[number]) =>
  registered.pipe(Layer.provideMerge(Control.layer({ stores, nodeSilentAfter: SILENT_AFTER })));

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
        const control = yield* Control.Control;
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
          payload: { label: "Checkout flow", tags: { team: "shop", stage: "qa" } },
        });
        expect(named).toMatchObject({
          label: "Checkout flow",
          tags: { team: "shop", stage: "qa" },
        });
        const retagged = yield* ada.api.sessions.describe({
          params: { id: session },
          payload: { tags: { team: "shop" } },
        });
        expect(retagged).toMatchObject({ label: "Checkout flow", tags: { team: "shop" } });
        const described = yield* ada.api.snapshots.describe({
          ...at,
          payload: { description: "After signing in", tags: { team: "shop" } },
        });
        expect(described).toMatchObject({
          name: "signed in",
          description: "After signing in",
          tags: { team: "shop" },
        });

        // A session's routing is set through the control plane, and read back from it.
        const routed = {
          proxy: {
            upstreams: { office: { url: "socks5://user:secret@127.0.0.1:9" } },
            rules: [{ match: "*.internal.test", via: "office" }],
          },
        };
        expect(yield* ada.api.sessions.proxy({ params: { id: session } })).toEqual({ proxy: null });
        yield* ada.api.sessions.setProxy({ params: { id: session }, payload: routed });
        expect(yield* ada.api.sessions.proxy({ params: { id: session } })).toEqual(routed);
        yield* ada.api.sessions.setProxy({ params: { id: session }, payload: { proxy: null } });
        expect(yield* ada.api.sessions.proxy({ params: { id: session } })).toEqual({ proxy: null });
        const refusedRoute = yield* Effect.flip(
          ada.api.sessions.setProxy({
            params: { id: session },
            payload: { proxy: { rules: [{ match: "*", via: "nowhere-named" }] } },
          }),
        );
        expect(refusedRoute._tag).toBe("NodeRefused");

        // A snapshot taken in another's place keeps what that one was called and tagged with.
        const again = yield* ada.api.snapshots.take({
          params: { id: session },
          payload: { replaces: taken.id, description: "Signed in, a day later" },
        });
        expect(again.id).not.toBe(taken.id);
        expect(again).toMatchObject({
          name: "signed in",
          description: "Signed in, a day later",
          tags: { team: "shop" },
        });
        expect((yield* ada.api.snapshots.list()).map((listed) => listed.id)).toEqual([again.id]);
        expect((yield* Effect.flip(executor.client.snapshots.get(taken.id))).code).toBe(
          "not_found",
        );

        // A token held to resources reaches what they name, and nothing else of its account's.
        const held = yield* ada.api.accounts.createOwnToken({
          payload: {
            name: "one session",
            scopes: ["sessions:write", "snapshots:read"],
            resources: { workspaces: [], sessions: [session], snapshots: [] },
          },
        });
        const asHeld = yield* control.as(held.token);
        expect((yield* asHeld.sessions.list()).map((listed) => listed.id)).toEqual([session]);
        expect(yield* asHeld.snapshots.list()).toEqual([]);
        expect((yield* Effect.flip(asHeld.snapshots.get({ params: { id: again.id } })))._tag).toBe(
          "SnapshotNotFound",
        );
        expect((yield* Effect.flip(asHeld.sessions.create({ payload: {} })))._tag).toBe(
          "Forbidden",
        );
        expect((yield* asHeld.sessions.describe({ params: { id: session }, payload: {} })).id).toBe(
          session,
        );

        yield* ada.api.snapshots.delete({ params: { id: again.id } });
        expect(yield* ada.api.snapshots.list()).toEqual([]);
        expect((yield* Effect.flip(executor.client.snapshots.get(taken.id))).code).toBe(
          "not_found",
        );
      }),
    );

    it.effect("what is a workspace's is all its members', and nobody else's", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const team = yield* ada.api.workspaces.create({ payload: { name: "Shop team" } });
        expect(team).toMatchObject({ name: "Shop team", role: "admin" });
        const shared = yield* ada.api.sessions.create({
          payload: { workspaceId: team.id, suspended: true, label: "Shared" },
        });
        expect(shared.workspaceId).toBe(team.id);

        const bob = yield* Control.account("Bob");
        const at = { params: { id: shared.id } };
        expect((yield* Effect.flip(bob.api.sessions.get(at)))._tag).toBe("SessionNotFound");
        expect(yield* bob.api.workspaces.list()).toEqual([]);
        // Nobody makes a session in a workspace they are not in, nor says who is in it.
        const outside = yield* Effect.flip(
          bob.api.sessions.create({ payload: { workspaceId: team.id } }),
        );
        expect(outside._tag).toBe("WorkspaceNotFound");

        const member = { params: { id: team.id, accountId: bob.account.id } };
        yield* ada.api.workspaces.admit({ ...member, payload: { role: "member" } });
        // The same token, now of a member: what it reaches is told anew with each request.
        const asBob = yield* control.as(bob.token);
        expect((yield* asBob.sessions.get(at)).label).toBe("Shared");
        expect((yield* asBob.sessions.list()).map((one) => one.id)).toEqual([shared.id]);
        expect((yield* asBob.workspaces.list()).map((one) => one.role)).toEqual(["member"]);
        expect((yield* asBob.workspaces.members({ params: { id: team.id } })).length).toBe(2);
        const notTheirs = yield* Effect.flip(
          asBob.workspaces.admit({ ...member, payload: { role: "admin" } }),
        );
        expect(notTheirs._tag).toBe("Forbidden");
        // Ada's own sessions stay hers.
        expect((yield* Effect.flip(asBob.sessions.get({ params: { id: session } })))._tag).toBe(
          "SessionNotFound",
        );

        const inUse = yield* Effect.flip(ada.api.workspaces.delete({ params: { id: team.id } }));
        expect(inUse._tag).toBe("WorkspaceInUse");
        yield* ada.api.workspaces.dismiss(member);
        expect((yield* Effect.flip(asBob.sessions.get(at)))._tag).toBe("SessionNotFound");
        yield* ada.api.sessions.delete(at);
        yield* ada.api.workspaces.delete({ params: { id: team.id } });
        expect(yield* ada.api.workspaces.list()).toEqual([]);
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

    it.effect("an account a session names is disabled with it, and removed once it is gone", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const bea = yield* Control.account("Bea");
        const at = { params: { id: bea.account.id } };
        const made = yield* bea.api.sessions.create({ payload: { suspended: true } });

        expect(yield* Effect.flip(bootstrap.accounts.remove(at))).toMatchObject({
          _tag: "AccountInUse",
          message: expect.stringContaining("1 session and 0 snapshots"),
        });
        // Disabled, it is nobody's caller, and what is its own stays for an admin to see.
        yield* bootstrap.accounts.disable(at);
        expect((yield* Effect.flip(bea.api.sessions.list()))._tag).toBe("Unauthorized");
        expect((yield* bootstrap.sessions.get({ params: { id: made.id } })).accountId).toBe(
          bea.account.id,
        );

        yield* bootstrap.sessions.delete({ params: { id: made.id } });
        yield* bootstrap.accounts.remove(at);
        expect(
          (yield* bootstrap.accounts.list()).filter((account) => account.id === bea.account.id),
        ).toEqual([]);
      }),
    );
  });
}
