import { proto } from "@aperture-browser/executor-client";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ExecutorService } from "../src/executor.ts";
import { cookiesLeft, leaveCookie } from "../src/profile.ts";
import { Nodes } from "../src/store.ts";
import * as Store from "../src/store.ts";
import { suite } from "../src/suite.ts";

const nodes = Store.layer((store) => ({
  features: ["cdp"],
  env: {
    APERTURE_SNAPSHOT_STORE: store,
    APERTURE_SESSION_STORE: store,
    APERTURE_SESSION_LOCKS: "true",
  },
}));

/** What a node is called in the store, which is how a refusal names who has a session. */
const named = (name: string) => ({ APERTURE_NODE: name });

suite(nodes)("nodes that say in the store which sessions they have", (it) => {
  let a: ExecutorService;
  let b: ExecutorService;
  let c: ExecutorService;
  let held: proto.Session;
  let built: proto.Session;
  let snapshot: proto.Snapshot;

  it.effect("a session that is suspended is free for another node to resume", () =>
    Effect.gen(function* () {
      const store = yield* Nodes;
      a = yield* store.start(named("a"));
      b = yield* store.start(named("b"));

      held = yield* a.client.sessions.create();
      yield* leaveCookie(a, held.id, "one");
      const suspended = yield* a.client.sessions.suspend(held.id);
      expect(suspended.state).toBe(proto.SessionState.SUSPENDED);

      const resumed = yield* b.client.sessions.resume(held.id);
      expect(resumed.state).toBe(proto.SessionState.RUNNING);
      expect(yield* cookiesLeft(b, held.id)).toEqual(["one"]);
    }),
  );

  it.effect("the first node resumes it again, with what the other node left", () =>
    Effect.gen(function* () {
      yield* leaveCookie(b, held.id, "two");
      yield* b.client.sessions.suspend(held.id);

      const resumed = yield* a.client.sessions.resume(held.id);
      expect(resumed.state).toBe(proto.SessionState.RUNNING);
      expect(yield* cookiesLeft(a, held.id)).toEqual(["one", "two"]);
    }),
  );

  it.effect("a node refuses a session another node has, and says which", () =>
    Effect.gen(function* () {
      const refused = yield* b.rpc("ResumeSession", { id: held.id });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("failed_precondition");
      expect(refused.body.message).toContain("node a");
    }),
  );

  it.effect("it refuses also once that node died", () =>
    Effect.gen(function* () {
      // Left in a run that never ends in a suspend, so it is in no store.
      yield* leaveCookie(a, held.id, "three");
      yield* a.dies;

      const refused = yield* b.rpc("ResumeSession", { id: held.id });
      expect(refused.body.code).toBe("failed_precondition");
    }),
  );

  it.effect("asked to take the session over, it resumes it as it was last suspended", () =>
    Effect.gen(function* () {
      const taken = yield* b.client.sessions.resume(held.id, { takeover: true });
      expect(taken.state).toBe(proto.SessionState.RUNNING);
      expect(yield* cookiesLeft(b, held.id)).toEqual(["one", "two"]);
    }),
  );

  it.effect("a node that had nothing resumes a session built on a snapshot", () =>
    Effect.gen(function* () {
      const store = yield* Nodes;
      snapshot = yield* b.client.snapshots.create({ sessionId: held.id });
      built = yield* b.client.sessions.create({ snapshotId: snapshot.id });
      yield* leaveCookie(b, built.id, "four");
      yield* b.client.sessions.suspend(built.id);

      c = yield* store.start(named("c"));
      const resumed = yield* c.client.sessions.resume(built.id);
      expect(resumed.state).toBe(proto.SessionState.RUNNING);
      expect(yield* cookiesLeft(c, built.id)).toEqual(["four", "one", "two"]);
    }),
  );

  it.effect("the session keeps which snapshot it was created from", () =>
    Effect.gen(function* () {
      const session = yield* c.client.sessions.get(built.id);
      expect(session.snapshotId).toBe(snapshot.id);
    }),
  );

  it.effect("a session deleted on a node that does not have it is resumed by none", () =>
    Effect.gen(function* () {
      const store = yield* Nodes;
      yield* c.client.sessions.delete(held.id);

      const d = yield* store.start(named("d"));
      const refused = yield* d.rpc("ResumeSession", { id: held.id });
      expect(refused.status).toBe(404);
      expect(refused.body.code).toBe("not_found");
    }),
  );
});
