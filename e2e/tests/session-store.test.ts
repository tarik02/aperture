import { proto } from "@aperture-browser/executor-client";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ExecutorService } from "../src/executor.ts";
import { refusal } from "../src/http.ts";
import * as Node from "../src/node.ts";
import { cookiesLeft, leaveCookie } from "../src/profile.ts";
import { Nodes } from "../src/store.ts";
import * as Store from "../src/store.ts";
import { suite } from "../src/suite.ts";

const PNG = [0x89, 0x50, 0x4e, 0x47];
const isPng = (bytes: Uint8Array) => PNG.every((byte, at) => bytes[at] === byte);

const nodes = Store.layer((store) => ({
  features: ["cdp"],
  env: { APERTURE_SNAPSHOT_STORE: store, APERTURE_SESSION_STORE: store },
}));

suite(nodes)("sessions in a store that nodes share", (it) => {
  let a: ExecutorService;
  let b: ExecutorService;
  let c: ExecutorService;
  let moved: proto.Session;
  let built: proto.Session;
  let snapshot: proto.Snapshot;

  it.effect("a session suspended on one node is resumed on another, with its profile", () =>
    Effect.gen(function* () {
      const store = yield* Nodes;
      a = yield* store.start();
      b = yield* store.start();

      moved = yield* a.client.sessions.create();
      yield* leaveCookie(a, moved.id, "one");
      // A session that was never suspended has no picture of what it showed last.
      expect((yield* a.session(moved.id, "GET", "/preview.png")).status).toBe(404);
      const suspended = yield* a.client.sessions.suspend(moved.id);
      expect(suspended.state).toBe(proto.SessionState.SUSPENDED);
      // Suspended, it has one, and asking for it leaves the session at rest.
      expect(isPng(yield* Node.bytes(a, moved.id, "/preview.png"))).toBe(true);
      expect((yield* a.client.sessions.get(moved.id)).state).toBe(proto.SessionState.SUSPENDED);

      const resumed = yield* b.client.sessions.resume(moved.id);
      expect(resumed.state).toBe(proto.SessionState.RUNNING);
      expect(yield* cookiesLeft(b, moved.id)).toEqual(["one"]);
      // The picture came with the session, from the node that took it.
      expect(isPng(yield* Node.bytes(b, moved.id, "/preview.png"))).toBe(true);
    }),
  );

  it.effect("the first node resumes it again, with what the other node left", () =>
    Effect.gen(function* () {
      yield* leaveCookie(b, moved.id, "two");
      yield* b.client.sessions.suspend(moved.id);

      const resumed = yield* a.client.sessions.resume(moved.id);
      expect(resumed.state).toBe(proto.SessionState.RUNNING);
      expect(yield* cookiesLeft(a, moved.id)).toEqual(["one", "two"]);
    }),
  );

  it.effect("a session whose node died is resumed elsewhere as it was last suspended", () =>
    Effect.gen(function* () {
      // Left in a run that never ends in a suspend, so it is in no store.
      yield* leaveCookie(a, moved.id, "three");
      yield* a.dies;

      const taken = yield* b.client.sessions.resume(moved.id);
      expect(taken.state).toBe(proto.SessionState.RUNNING);
      expect(yield* cookiesLeft(b, moved.id)).toEqual(["one", "two"]);
    }),
  );

  it.effect("a node that had nothing resumes a session built on a snapshot", () =>
    Effect.gen(function* () {
      const store = yield* Nodes;
      snapshot = yield* b.client.snapshots.create({ sessionId: moved.id });
      built = yield* b.client.sessions.create({ snapshotId: snapshot.id });
      yield* leaveCookie(b, built.id, "four");
      yield* b.client.sessions.suspend(built.id);

      c = yield* store.start();
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
      yield* c.client.sessions.delete(moved.id);

      const d = yield* store.start();
      const refused = yield* d.rpc("ResumeSession", { id: moved.id });
      expect(refused.status).toBe(404);
      expect((yield* refusal(refused)).code).toBe("not_found");
    }),
  );
});
