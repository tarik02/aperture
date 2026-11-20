import { proto } from "@aperture-browser/executor-client";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ExecutorService } from "../src/executor.ts";
import { cookiesLeft, leaveCookie } from "../src/profile.ts";
import { layersOn, Nodes } from "../src/store.ts";
import * as Store from "../src/store.ts";
import { suite } from "../src/suite.ts";

const nodes = Store.layer((store) => ({
  features: ["cdp"],
  env: { APERTURE_SNAPSHOT_STORE: store },
}));

suite(nodes)("snapshots in a store that nodes share", (it) => {
  let a: ExecutorService;
  let b: ExecutorService;
  let c: ExecutorService;
  let first: proto.Snapshot;
  let second: proto.Snapshot;

  it.effect("a snapshot taken on one node is listed and given by another", () =>
    Effect.gen(function* () {
      const store = yield* Nodes;
      a = yield* store.start();
      b = yield* store.start();

      const session = yield* a.client.sessions.create();
      yield* leaveCookie(a, session.id, "one");
      first = yield* a.client.snapshots.create({ sessionId: session.id, name: "first" });
      expect(first.id).not.toBe("");

      const listed = yield* b.client.snapshots.list;
      const seen = listed.find((snapshot) => snapshot.id === first.id);
      expect(seen?.name).toBe("first");
      const given = yield* b.client.snapshots.get(first.id);
      expect(given.id).toBe(first.id);
    }),
  );

  it.effect("a node has none of a snapshot's layers before it builds a session on it", () =>
    Effect.sync(() => {
      expect(layersOn(b)).toBe(0);
    }),
  );

  it.effect("a session is created from it there, with what the profile had", () =>
    Effect.gen(function* () {
      const session = yield* b.client.sessions.create({ snapshotId: first.id });
      expect(session.state).toBe(proto.SessionState.RUNNING);
      expect(yield* cookiesLeft(b, session.id)).toEqual(["one"]);

      yield* leaveCookie(b, session.id, "two");
      second = yield* b.client.snapshots.create({ sessionId: session.id });
      expect(second.id).not.toBe("");
    }),
  );

  it.effect("the first node builds on the layers of both nodes", () =>
    Effect.gen(function* () {
      const session = yield* a.client.sessions.create({ snapshotId: second.id });
      expect(yield* cookiesLeft(a, session.id)).toEqual(["one", "two"]);
    }),
  );

  it.effect("a snapshot deleted on one node is gone for the other", () =>
    Effect.gen(function* () {
      yield* a.client.snapshots.delete(first.id);

      const left = yield* b.client.snapshots.list;
      const ids = left.map((snapshot) => snapshot.id);
      expect(ids).not.toContain(first.id);
      expect(ids).toContain(second.id);
    }),
  );

  it.effect("no session is created from a deleted snapshot", () =>
    Effect.gen(function* () {
      const refused = yield* b.rpc("CreateSession", { snapshotId: first.id });
      expect(refused.status).toBe(404);
      expect(refused.body.code).toBe("not_found");
    }),
  );

  it.effect("a node that had neither layer builds on the snapshot that is left", () =>
    Effect.gen(function* () {
      const store = yield* Nodes;
      c = yield* store.start();

      const session = yield* c.client.sessions.create({ snapshotId: second.id });
      expect(session.state).toBe(proto.SessionState.RUNNING);
      expect(yield* cookiesLeft(c, session.id)).toEqual(["one", "two"]);
      // The snapshot that was deleted is still a layer of the one built above it.
      expect(layersOn(c)).toBe(2);
    }),
  );

  it.effect("the nodes keep no layer that nothing is built on", () =>
    Effect.gen(function* () {
      for (const node of [a, b, c]) {
        const sessions = yield* node.client.sessions.list;
        for (const session of sessions) {
          yield* node.client.sessions.delete(session.id);
        }
      }
      yield* c.client.snapshots.delete(second.id);

      // A node learns that a snapshot is gone when it next looks at the store.
      for (const node of [a, b, c]) {
        yield* node.client.snapshots.list;
      }
      expect([layersOn(a), layersOn(b), layersOn(c)]).toEqual([0, 0, 0]);
    }),
  );
});
