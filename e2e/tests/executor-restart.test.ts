import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Executor } from "../src/executor.ts";
import * as Node from "../src/node.ts";
import { suite } from "../src/suite.ts";
import { until } from "../src/wait.ts";

// A node's sessions are found again by what their runners keep in the runtime directory. A
// runner whose directory is gone, as when whatever ran the node removed it with the node,
// is reached by nothing, and would hold its session's profile for as long as it ran.

const node = Node.layer();

suite(node)("the sessions of a node whose executor starts again", (it) => {
  it.effect("a running session runs on, and answers, once the executor is back", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const session = (yield* executor.client.sessions.create()).id;
      const runner = yield* Node.runnerOf(executor, session);

      yield* executor.restart();

      expect((yield* executor.client.sessions.get(session)).state).toBe(Node.SessionState.RUNNING);
      expect(yield* Node.runnerOf(executor, session)).toBe(runner);
      const reached = yield* executor.session(session, "GET", "/targets");
      expect(reached.status).toBe(200);
      expect(reached.body).toHaveLength(1);
      yield* executor.client.sessions.delete(session);
    }),
  );

  it.effect("a runner left without its state is stopped, and its session starts again", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const fs = yield* FileSystem.FileSystem;
      const session = (yield* executor.client.sessions.create()).id;
      expect(yield* Node.processesOf(executor, session)).not.toEqual([]);

      yield* fs.remove(`${executor.runtime}/${session}`, { recursive: true });
      yield* executor.restart();
      yield* until(
        "the runner left without its state being stopped",
        Node.processesOf(executor, session).pipe(Effect.map((left) => left.length === 0)),
        "30 seconds",
      );
      const left = yield* executor.client.sessions.get(session);
      expect([left.state, left.failure]).toEqual([Node.SessionState.SUSPENDED, undefined]);

      // Nothing holds its profile any more.
      yield* executor.client.sessions.resume(session);
      expect((yield* executor.session(session, "GET", "/targets")).status).toBe(200);
      yield* executor.client.sessions.delete(session);
    }),
  );

  it.effect("deleting a session stops a runner of it that is left without its state", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const fs = yield* FileSystem.FileSystem;
      const session = (yield* executor.client.sessions.create()).id;
      yield* fs.remove(`${executor.runtime}/${session}`, { recursive: true });
      expect((yield* executor.client.sessions.get(session)).state).toBe(
        Node.SessionState.SUSPENDED,
      );

      yield* executor.client.sessions.delete(session);
      yield* until(
        "the session's runner and browser being gone",
        Node.processesOf(executor, session).pipe(Effect.map((left) => left.length === 0)),
        "30 seconds",
      );
    }),
  );
});
