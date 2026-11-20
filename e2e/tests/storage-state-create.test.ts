import { proto } from "@aperture-browser/executor-client";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Executor from "../src/executor.ts";
import { suite } from "../src/suite.ts";

const node = Executor.layer();

const state = {
  cookies: [
    {
      name: "sid",
      value: "abc",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      expires: Date.now() / 1000 + 60 * 60,
    },
  ],
  origins: [
    {
      origin: "https://example.com",
      localStorage: [{ name: "token", value: "t1" }],
    },
  ],
};

suite(node)("a storage state given when a session is created", (it) => {
  let created: proto.Session;

  it.effect("the session's browser starts with its cookies and storage", () =>
    Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      created = yield* executor.client.sessions.create({ storageState: JSON.stringify(state) });
      expect(created.state).toBe(proto.SessionState.RUNNING);

      const taken = yield* executor.session(created.id, "POST", "/storage-state", {
        origins: ["https://example.com"],
      });
      expect(taken.status).toBe(200);
      expect(taken.body.cookies).toHaveLength(1);
      expect(taken.body.cookies[0]).toMatchObject({ name: "sid", value: "abc", httpOnly: true });
      expect(taken.body.origins[0].localStorage).toEqual([{ name: "token", value: "t1" }]);
    }),
  );

  it.effect("a state the browser does not take makes no session", () =>
    Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      const unknownPart = {
        origins: [{ origin: "https://example.com", opfs: [{ path: "a" }] }],
      };
      const refused = yield* executor.rpc("CreateSession", {
        storageState: JSON.stringify(unknownPart),
      });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("invalid_argument");

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
      expect(refused.body.code).toBe("invalid_argument");
    }),
  );
});
