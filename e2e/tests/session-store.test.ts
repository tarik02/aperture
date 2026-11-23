import { proto } from "@aperture-browser/executor-client";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ExecutorService } from "../src/executor.ts";
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

// What nodes that share a store do with a session is checked where they say which of them
// has it, in `session-locks.test.ts`: here is what only nodes that do not say so do.
suite(nodes)("sessions in a store that nodes share", (it) => {
  let a: ExecutorService;
  let b: ExecutorService;
  let moved: proto.Session;

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

  it.effect("a session whose node died is resumed elsewhere as it was last suspended", () =>
    Effect.gen(function* () {
      // Left in a run that never ends in a suspend, so it is in no store. No node says in
      // the store which sessions it has, so none stands in the way of another.
      yield* leaveCookie(b, moved.id, "two");
      yield* b.dies;

      const taken = yield* a.client.sessions.resume(moved.id);
      expect(taken.state).toBe(proto.SessionState.RUNNING);
      expect(yield* cookiesLeft(a, moved.id)).toEqual(["one"]);
    }),
  );
});
