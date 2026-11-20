import { proto } from "@aperture-browser/executor-client";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Executor from "../src/executor.ts";
import type { ExecutorService } from "../src/executor.ts";
import { cookiesLeft, leaveCookie } from "../src/profile.ts";
import { Nodes } from "../src/store.ts";
import * as Store from "../src/store.ts";
import { suite } from "../src/suite.ts";
import { until } from "../src/wait.ts";

const nodes = Store.layer((store) => ({
  features: ["cdp"],
  env: { APERTURE_SNAPSHOT_STORE: store, APERTURE_SESSION_STORE: store },
}));

/** What a watcher is told of a session, as a word a check reads. */
const told = (event: proto.WatchSessionsResponse): string => {
  switch (event.event.case) {
    case "session":
      return `${event.event.value.id} ${proto.SessionState[event.event.value.state]}`;
    case "gone":
      return `${event.event.value} gone`;
    default:
      return "nothing";
  }
};

suite(nodes)("what whoever runs several nodes asks of each", (it) => {
  let a: ExecutorService;
  let b: ExecutorService;
  let session: proto.Session;

  it.effect("a watcher is told of a session as it comes, changes and goes", () =>
    Effect.gen(function* () {
      const store = yield* Nodes;
      a = yield* store.start();
      const before = yield* a.client.sessions.create({ suspended: true });

      const heard: string[] = [];
      yield* a.client.sessions.watch.pipe(
        Stream.runForEach((event) => Effect.sync(() => heard.push(told(event)))),
        Effect.forkScoped,
      );
      const hears = (word: string) =>
        until(
          `the watcher hearing "${word}"`,
          Effect.sync(() => heard.includes(word)),
        );

      // What there was when the watching began comes first.
      yield* hears(`${before.id} SUSPENDED`);
      expect(heard).toEqual([`${before.id} SUSPENDED`]);

      const fresh = yield* a.client.sessions.create();
      yield* hears(`${fresh.id} RUNNING`);
      yield* a.client.sessions.suspend(fresh.id);
      yield* hears(`${fresh.id} SUSPENDED`);
      yield* a.client.sessions.delete(fresh.id);
      yield* hears(`${fresh.id} gone`);

      // A session that stays as it is is told once.
      expect(heard.filter((word) => word.startsWith(before.id))).toHaveLength(1);
      yield* a.client.sessions.delete(before.id);
    }),
  );

  it.effect("a session at rest is where nodes share sessions, for any node to list", () =>
    Effect.gen(function* () {
      const store = yield* Nodes;
      b = yield* store.start();
      session = yield* a.client.sessions.create();
      yield* leaveCookie(a, session.id, "one");
      yield* a.client.sessions.suspend(session.id);

      const stored = yield* b.client.sessions.stored;
      expect(stored.map((one) => one.id)).toEqual([session.id]);
      expect(stored[0]?.heldBy).toBeUndefined();
    }),
  );

  it.effect("a node drops its copy of it, and the session stays for another to resume", () =>
    Effect.gen(function* () {
      yield* a.client.sessions.evict(session.id);

      expect((yield* a.client.sessions.list).map((one) => one.id)).not.toContain(session.id);
      expect((yield* a.client.sessions.stored).map((one) => one.id)).toEqual([session.id]);

      const resumed = yield* b.client.sessions.resume(session.id);
      expect(resumed.state).toBe(proto.SessionState.RUNNING);
      expect(yield* cookiesLeft(b, session.id)).toEqual(["one"]);
    }),
  );

  it.effect("a session that runs is not evicted, nor one the node has not", () =>
    Effect.gen(function* () {
      const running = yield* b.rpc("EvictSession", { id: session.id });
      expect(running.status).toBe(400);
      expect(running.body.code).toBe("failed_precondition");

      const absent = yield* a.rpc("EvictSession", { id: session.id });
      expect(absent.status).toBe(404);
      expect(absent.body.code).toBe("not_found");
    }),
  );

  it.effect("a node that shares no sessions neither evicts nor lists what is shared", () =>
    Effect.gen(function* () {
      const alone = yield* Executor.start({ features: ["cdp"] });
      const own = yield* alone.client.sessions.create({ suspended: true });

      const evicted = yield* alone.rpc("EvictSession", { id: own.id });
      expect(evicted.body.code).toBe("failed_precondition");
      const listed = yield* alone.rpc("ListStoredSessions");
      expect(listed.body.code).toBe("failed_precondition");
    }),
  );
});
