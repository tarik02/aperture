import type { Caller } from "@aperture-browser/control-api";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import * as App from "../src/app.ts";
import * as Database from "../src/database.ts";
import * as Events from "../src/events/layer.ts";
import * as Forgetting from "../src/grants/forgetting.ts";
import * as GrantsLive from "../src/grants/layer.ts";
import { Grants } from "../src/grants/service.ts";
import * as GrantsStoreSql from "../src/grants/store-sql.ts";
import * as Postgres from "./src/postgres.ts";

const REDIRECT = "http://127.0.0.1:9/callback";
const ADA = "00000000-0000-7000-8000-000000000001";

const ada: Caller = {
  account: Option.some({
    id: ADA,
    name: "Ada",
    admin: false,
    kind: "person",
    email: "ada@example.test",
    createdAt: DateTime.makeUnsafe(0),
    disabledAt: null,
  }),
  admin: false,
  scopes: null,
  resources: null,
  workspaces: [],
};

const registered = (name: string) =>
  Grants.use((grants) => grants.register({ name, redirectUris: [REDIRECT] }));

/** Whether the app is still one that may ask a person for a grant. */
const known = (clientId: string) =>
  Grants.use((grants) => grants.asking({ clientId, redirectUri: REDIRECT })).pipe(
    Effect.as(true),
    Effect.catchTag("OAuthClientNotFound", () => Effect.succeed(false)),
  );

/** An app nobody gave a grant, and one whose grant the person took back. */
const apps = Effect.gen(function* () {
  const grants = yield* Grants;
  const ungranted = yield* registered("Never granted");
  const granted = yield* registered("Granted once");
  yield* grants.approve(ada, {
    clientId: granted.id,
    redirectUri: REDIRECT,
    codeChallenge: "a challenge",
    scopes: ["sessions:read"],
    resources: undefined,
  });
  const [grant] = yield* grants.list(ada);
  yield* grants.revoke(ada, grant?.id ?? "");
  expect(yield* grants.list(ada)).toEqual([]);
  return { ungranted: ungranted.id, granted: granted.id };
});

const memory = Forgetting.layer.pipe(
  Layer.provideMerge(GrantsLive.layer),
  Layer.provide(Events.layerTest),
  Layer.provide(App.storesTest),
  Layer.provide(NodeServices.layer),
);

it.effect("an app nobody gave a grant is forgotten a day after it registered", () =>
  Effect.gen(function* () {
    const { ungranted, granted } = yield* apps;
    yield* TestClock.adjust("23 hours");
    expect(yield* known(ungranted)).toBe(true);
    const late = yield* registered("Registered later");

    yield* TestClock.adjust("2 hours");
    expect(yield* known(ungranted)).toBe(false);
    // One that was given a grant asks again as what it registered as, whenever.
    expect(yield* known(granted)).toBe(true);
    expect(yield* known(late.id)).toBe(true);
  }).pipe(Effect.provide(memory)),
);

const database = GrantsLive.layer.pipe(
  Layer.provide(Events.layerTest),
  Layer.provideMerge(GrantsStoreSql.layer),
  Layer.provideMerge(
    Layer.effectDiscard(Database.migrate).pipe(
      Layer.provideMerge(
        Layer.unwrap(
          Effect.gen(function* () {
            const postgres = yield* Postgres.Postgres;
            return PgClient.layer({
              url: Redacted.make(postgres.url),
              transformResultNames: Str.snakeToCamel,
            });
          }),
        ),
      ),
    ),
  ),
  Layer.provide(Postgres.layer),
);

suite(database)("what apps left, kept in postgres", (it) => {
  it.effect("an app nobody gave a grant is forgotten a day after it registered", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const grants = yield* Grants;
      yield* sql`INSERT INTO accounts (id, name, admin, created_at)
        VALUES (${ADA}, 'Ada', false, now())`;
      const { ungranted, granted } = yield* apps;
      const late = yield* registered("Registered later");
      yield* grants.forget();
      expect(yield* known(ungranted)).toBe(true);

      yield* sql`UPDATE oauth_clients SET created_at = created_at - interval '25 hours'
        WHERE id IN (${ungranted}, ${granted})`;
      yield* grants.forget();
      expect(yield* known(ungranted)).toBe(false);
      expect(yield* known(granted)).toBe(true);
      expect(yield* known(late.id)).toBe(true);
    }),
  );
});
