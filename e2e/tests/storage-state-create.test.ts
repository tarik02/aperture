import { proto } from "@aperture-browser/executor-client";
import { expect } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Executor from "../src/executor.ts";
import { read, refusal } from "../src/http.ts";
import { suite } from "../src/suite.ts";

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
      expect(created.state).toBe(proto.SessionState.RUNNING);

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

  it.effect("a state the browser does not take makes no session", () =>
    Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      const noPage = { tabs: [{ url: "about:blank" }] };
      const refused = yield* executor.rpc("CreateSession", {
        storageState: JSON.stringify(noPage),
      });
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
