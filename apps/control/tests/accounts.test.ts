import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";

const OpenApi = Schema.Struct({
  openapi: Schema.String,
  paths: Schema.Record(Schema.String, Schema.Unknown),
});

suite(Control.layer())("accounts and their tokens", (it) => {
  it.effect("the bootstrap token makes an account and a token that works", () =>
    Effect.gen(function* () {
      const ada = yield* Control.account("Ada");
      expect(ada.token).toMatch(/^apc_/u);
      expect(ada.account).toMatchObject({ name: "Ada", admin: false });

      const current = yield* ada.api.accounts.current();
      expect(current.id).toBe(ada.account.id);
    }),
  );

  it.effect("a token is kept as its digest alone", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const grace = yield* Control.account("Grace");
      const kept = yield* control.sql`SELECT * FROM api_tokens`;
      expect(kept.length).toBeGreaterThan(0);
      expect(JSON.stringify(kept)).not.toContain(grace.token);
    }),
  );

  it.effect("a token that is nobody's is refused, and so is none", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const wrong = yield* control.as("apc_not-a-token");
      expect((yield* Effect.flip(wrong.accounts.current()))._tag).toBe("Unauthorized");

      const none = yield* control.request("", "GET", "/api/control/sessions");
      expect(none.status).toBe(401);
      const unknown = yield* control.request("apc_not-a-token", "GET", "/api/control/sessions");
      expect(unknown.status).toBe(401);
    }),
  );

  it.effect("an account that is no admin makes neither accounts nor tokens", () =>
    Effect.gen(function* () {
      const ada = yield* Control.account("Ada");
      const refused = yield* Effect.flip(ada.api.accounts.create({ payload: { name: "Eve" } }));
      expect(refused._tag).toBe("Forbidden");
      const own = yield* Effect.flip(
        ada.api.accounts.createToken({ params: { id: ada.account.id }, payload: { name: "more" } }),
      );
      expect(own._tag).toBe("Forbidden");
      expect((yield* Effect.flip(ada.api.accounts.list()))._tag).toBe("Forbidden");
    }),
  );

  it.effect("an admin account makes accounts and tokens as the bootstrap token does", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const root = yield* Control.account("Root", true);
      const made = yield* root.api.accounts.create({ payload: { name: "Linus" } });
      const token = yield* root.api.accounts.createToken({
        params: { id: made.id },
        payload: { name: "laptop" },
      });
      const linus = yield* control.as(token.token);
      expect((yield* linus.accounts.current()).name).toBe("Linus");

      const all = yield* root.api.accounts.list();
      expect(all.map((account) => account.name)).toContain("Linus");

      const missing = yield* Effect.flip(
        root.api.accounts.createToken({
          params: { id: "00000000-0000-7000-8000-000000000000" },
          payload: { name: "nobody's" },
        }),
      );
      expect(missing._tag).toBe("AccountNotFound");
    }),
  );

  it.effect("the bootstrap token is an admin's and no account's", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const bootstrap = yield* control.as(control.bootstrapToken);
      expect((yield* Effect.flip(bootstrap.accounts.current()))._tag).toBe("Forbidden");
      expect((yield* Effect.flip(bootstrap.sessions.create({ payload: {} })))._tag).toBe(
        "Forbidden",
      );
    }),
  );

  it.effect("the API is described where its clients look for it", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const answer = yield* control.request("", "GET", "/api/control/openapi.json");
      expect(answer.status).toBe(200);
      const described = yield* Schema.decodeUnknownEffect(OpenApi)(answer.body);
      expect(Object.keys(described.paths)).toEqual(
        expect.arrayContaining([
          "/api/control/accounts",
          "/api/control/sessions",
          "/api/control/sessions/{id}/tickets",
        ]),
      );
    }),
  );
});
