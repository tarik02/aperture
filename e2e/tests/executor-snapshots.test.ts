import { readdirSync } from "node:fs";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Executor } from "../src/executor.ts";
import * as Node from "../src/node.ts";
import { cookiesLeft, leaveCookie } from "../src/profile.ts";
import { suite } from "../src/suite.ts";
import { happens } from "../src/wait.ts";

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

  it.effect("a layer outlives its snapshot while sessions use it", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.client.snapshots.delete(snapshot);
      expect(readdirSync(`${executor.data}/layers`)).toHaveLength(1);
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
      expect(readdirSync(`${executor.data}/layers`)).toEqual([]);
    }),
  );

  it.effect("deleted sessions leave nothing in the node's data", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      expect(readdirSync(`${executor.data}/sessions`)).toEqual([]);
    }),
  );

  it.effect("and no process", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const gone = yield* happens(
        Effect.sync(() => Node.processes(executor).length === 0),
        5000,
      );
      expect(Node.processes(executor)).toEqual([]);
      expect(gone).toBe(true);
    }),
  );
});
