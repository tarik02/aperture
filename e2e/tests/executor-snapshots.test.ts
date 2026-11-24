import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Executor } from "../src/executor.ts";
import * as Node from "../src/node.ts";
import { cookiesLeft, leaveCookie } from "../src/profile.ts";
import { suite } from "../src/suite.ts";
import { happens, until } from "../src/wait.ts";

const node = Node.layer({ features: ["cdp"] });

suite(node)("snapshots, and the sessions of a node over its executor's restart", (it) => {
  let original: string;
  let copy: string;
  let snapshot: string;

  it.effect("a session runs again once a snapshot of it is taken", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      original = (yield* executor.client.sessions.create()).id;
      yield* leaveCookie(executor, original, "from_original");

      snapshot = (yield* executor.client.snapshots.create({ sessionId: original, name: "base" }))
        .id;

      const session = yield* executor.client.sessions.get(original);
      expect(session.state).toBe(Node.SessionState.RUNNING);
    }),
  );

  it.effect("and keeps its cookie over the snapshot", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      expect(yield* cookiesLeft(executor, original)).toEqual(["from_original"]);
    }),
  );

  it.effect("a session created from a snapshot starts with the snapshot's cookie", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      copy = (yield* executor.client.sessions.create({ snapshotId: snapshot })).id;
      expect(yield* cookiesLeft(executor, copy)).toEqual(["from_original"]);
    }),
  );

  it.effect("what it writes is above the snapshot's", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* leaveCookie(executor, copy, "from_copy");
      expect(yield* cookiesLeft(executor, copy)).toEqual(["from_copy", "from_original"]);
    }),
  );

  it.effect("and is not seen by the session the snapshot was taken of", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      expect(yield* cookiesLeft(executor, original)).toEqual(["from_original"]);
    }),
  );

  it.effect("both sessions survive a restart of the executor", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.restart();

      const sessions = yield* executor.client.sessions.list;
      expect(sessions.map((session) => session.id).sort()).toEqual([original, copy].sort());
      expect(sessions.map((session) => session.state)).toEqual([
        Node.SessionState.RUNNING,
        Node.SessionState.RUNNING,
      ]);
    }),
  );

  it.effect("a session is suspended when asked", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.client.sessions.suspend(original);
      const session = yield* executor.client.sessions.get(original);
      expect(session.state).toBe(Node.SessionState.SUSPENDED);
    }),
  );

  it.effect("and resumes with its cookie", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.client.sessions.resume(original);
      expect(yield* cookiesLeft(executor, original)).toEqual(["from_original"]);
    }),
  );

  it.effect(
    "a session nobody uses for longer than it may is suspended, and whoever reaches it has it run again",
    () =>
      Effect.gen(function* () {
        const executor = yield* Executor;
        const created = yield* executor.client.sessions.create({
          limits: { suspendIdleAfter: { seconds: 1n } },
        });
        const idle = created.id;
        yield* leaveCookie(executor, idle, "before_it_sat_idle");
        // The executor looks for idle sessions once in a while.
        yield* until(
          "the session being suspended for sitting idle",
          executor.client.sessions
            .get(idle)
            .pipe(
              Effect.map(
                (session) => session.state === Node.SessionState.SUSPENDED && session.asleep,
              ),
            ),
          "40 seconds",
        );

        // The first request for it is answered by the session, once it runs: none is
        // turned away for coming while it rests.
        const reached = yield* executor.session(idle, "GET", "/targets");
        expect(reached.status).toBe(200);
        expect(reached.body).toHaveLength(1);
        const woken = yield* executor.client.sessions.get(idle);
        expect([woken.state, woken.asleep]).toEqual([Node.SessionState.RUNNING, false]);
        expect(yield* cookiesLeft(executor, idle)).toEqual(["before_it_sat_idle"]);

        // One that was suspended because someone asked stays so, whoever reaches it.
        yield* executor.client.sessions.suspend(idle);
        expect((yield* executor.session(idle, "GET", "/targets")).status).not.toBe(200);
        const asked = yield* executor.client.sessions.get(idle);
        expect([asked.state, asked.asleep]).toEqual([Node.SessionState.SUSPENDED, false]);
        yield* executor.client.sessions.delete(idle);
      }),
  );

  it.effect("a layer outlives its snapshot while sessions use it", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.client.snapshots.delete(snapshot);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readDirectory(`${executor.data}/layers`)).toHaveLength(1);
    }),
  );

  it.effect("a session is resumed on a layer whose snapshot is gone", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.client.sessions.suspend(copy);
      yield* executor.client.sessions.resume(copy);
      expect(yield* cookiesLeft(executor, copy)).toEqual(["from_copy", "from_original"]);
    }),
  );

  it.effect("a layer is collected with the last session on it", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.client.sessions.delete(original);
      yield* executor.client.sessions.delete(copy);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readDirectory(`${executor.data}/layers`)).toEqual([]);
    }),
  );

  it.effect("deleted sessions leave nothing in the node's data", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readDirectory(`${executor.data}/sessions`)).toEqual([]);
    }),
  );

  it.effect("and no process", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const gone = yield* happens(
        Node.processes(executor).pipe(Effect.map((left) => left.length === 0)),
        "5 seconds",
      );
      expect(yield* Node.processes(executor)).toEqual([]);
      expect(gone).toBe(true);
    }),
  );
});
