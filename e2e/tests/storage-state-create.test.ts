import { proto } from "@aperture-browser/executor-client";
import { expect } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Executor from "../src/executor.ts";
import { read, refusal } from "../src/http.ts";
import { suite } from "../src/suite.ts";
import { until } from "../src/wait.ts";

const node = Executor.layer();

/** A state whose cookie lasts an hour from `now`, in milliseconds since the epoch. */
const stateAt = (now: number) => ({
  cookies: [
    {
      name: "sid",
      value: "abc",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      expires: now / 1000 + 60 * 60,
    },
  ],
  origins: [
    {
      origin: "https://example.com",
      localStorage: [{ name: "token", value: "t1" }],
    },
  ],
});

/** What a session's `storage-state` route tells of its browser, as far as the checks read it. */
const Taken = Schema.Struct({
  cookies: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  origins: Schema.Array(Schema.Struct({ localStorage: Schema.Unknown })),
});

suite(node)("a storage state given when a session is created", (it) => {
  let created: proto.Session;

  it.effect("the session's browser starts with its cookies and storage", () =>
    Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      const state = stateAt(yield* Clock.currentTimeMillis);
      created = yield* executor.client.sessions.create({ storageState: JSON.stringify(state) });
      // Answered for once its browser runs: the state is put in after, and the session
      // says so until all of it is in.
      expect(created.state).toBe(proto.SessionState.RESTORING);
      yield* until(
        "the session running",
        executor.client.sessions
          .get(created.id)
          .pipe(Effect.map((seen) => seen.state === proto.SessionState.RUNNING)),
        "60 seconds",
      );

      const taken = yield* executor.session(created.id, "POST", "/storage-state", {
        origins: ["https://example.com"],
      });
      expect(taken.status).toBe(200);
      const { cookies, origins } = yield* read(taken, Taken);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatchObject({ name: "sid", value: "abc", httpOnly: true });
      expect(origins[0]?.localStorage).toEqual([{ name: "token", value: "t1" }]);
    }),
  );

  it.effect("a session whose browser does not take the state fails, stopped, and says why", () =>
    Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      const noPage = { tabs: [{ url: "about:blank" }] };
      const made = yield* executor.client.sessions.create({ storageState: JSON.stringify(noPage) });
      expect(made.state).toBe(proto.SessionState.RESTORING);
      const failed = yield* until(
        "the session being told as failed",
        executor.client.sessions
          .get(made.id)
          .pipe(
            Effect.map((seen) => (seen.state === proto.SessionState.FAILED ? seen : undefined)),
          ),
        "60 seconds",
      );
      expect(failed.failure).toMatch(/the storage state was not taken: .*no page on the web/u);
      expect((yield* executor.session(made.id, "GET", "/targets")).status).toBe(409);
      yield* executor.client.sessions.delete(made.id);

      // What is no JSON at all is refused before anything is made.
      const refused = yield* executor.rpc("CreateSession", { storageState: "{" });
      expect(refused.status).toBe(400);
      expect((yield* refusal(refused)).code).toBe("invalid_argument");
      const sessions = yield* executor.client.sessions.list;
      expect(sessions.map((session) => session.id)).toEqual([created.id]);
    }),
  );

  it.effect("a session created suspended takes no state", () =>
    Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      const refused = yield* executor.rpc("CreateSession", {
        suspended: true,
        storageState: "{}",
      });
      expect(refused.status).toBe(400);
      expect((yield* refusal(refused)).code).toBe("invalid_argument");
    }),
  );
});
