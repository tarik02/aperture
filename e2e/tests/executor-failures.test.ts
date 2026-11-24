import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Executor } from "../src/executor.ts";
import * as Node from "../src/node.ts";
import { kill } from "../src/process.ts";
import { cookiesLeft, leaveCookie } from "../src/profile.ts";
import { suite } from "../src/suite.ts";
import { happens } from "../src/wait.ts";

const node = Node.layer({ features: ["cdp"] });

/** How long the processes of a session that failed get to be gone. */
const GONE_WITHIN = "5 seconds";

suite(node)("a session whose processes die", (it) => {
  let session: string;

  /** Whether no process of the session is left, once what was ending had time to end. */
  const leftNoProcess = Effect.gen(function* () {
    const executor = yield* Executor;
    return yield* happens(
      Node.processesOf(executor, session).pipe(Effect.map((left) => left.length === 0)),
      GONE_WITHIN,
    );
  });

  it.effect("a browser that dies takes the session down, and the session says so", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      session = (yield* executor.client.sessions.create()).id;
      yield* leaveCookie(executor, session, "kept");
      // A browser that is killed loses what it had not written yet. One that is suspended
      // has written its cookies, which is the profile the session is to resume with.
      yield* executor.client.sessions.suspend(session);
      yield* executor.client.sessions.resume(session);

      const browser = yield* Node.browserOf(executor, session);
      expect(browser).toBeDefined();
      yield* kill(browser!.pid);

      const failed = yield* Node.inState(executor, session, Node.SessionState.FAILED);
      expect(failed.failure).toMatch(/browser exited/u);
    }),
  );

  it.effect("the processes of a session whose browser died are gone", () =>
    Effect.gen(function* () {
      expect(yield* leftNoProcess).toBe(true);
    }),
  );

  it.effect("a session resumes after the failure with its profile", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.client.sessions.resume(session);
      expect(yield* cookiesLeft(executor, session)).toEqual(["kept"]);
    }),
  );

  it.effect("a runner that is killed leaves the session failed", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* kill(yield* Node.runnerOf(executor, session));

      const failed = yield* Node.inState(executor, session, Node.SessionState.FAILED);
      expect(failed.state).toBe(Node.SessionState.FAILED);
    }),
  );

  it.effect("and takes its browser and desktop with it", () =>
    Effect.gen(function* () {
      expect(yield* leftNoProcess).toBe(true);
    }),
  );
});
