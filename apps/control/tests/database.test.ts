import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Database from "../src/database.ts";
import * as Postgres from "./src/postgres.ts";

const database = Layer.unwrap(
  Effect.gen(function* () {
    const postgres = yield* Postgres.Postgres;
    return PgClient.layer({ url: Redacted.make(postgres.url) });
  }),
).pipe(Layer.provideMerge(Postgres.layer));

const Tables = Schema.Array(Schema.Struct({ table_name: Schema.String }));

suite(database)("the database", (it) => {
  it.effect("an empty one is brought to what the program expects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const applied = yield* Database.migrate;
      expect(applied.map(([, name]) => name)).toEqual([
        "initial",
        "clients_granted",
        "session_shares",
        "accounts_disabled",
      ]);

      const tables = yield* sql`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Tables)));
      expect(tables.map((table) => table.table_name).toSorted()).toEqual([
        "accounts",
        "api_tokens",
        "control_migrations",
        "nodes",
        "oauth_clients",
        "oauth_codes",
        "oauth_grants",
        "oauth_tokens",
        "registration_tokens",
        "session_shares",
        "sessions",
        "snapshots",
        "workspace_members",
        "workspaces",
      ]);
    }),
  );

  it.effect("one that is there already is left as it is", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO accounts (id, name, admin, created_at)
        VALUES ('00000000-0000-7000-8000-000000000001', 'Ada', false, now())`;
      expect(yield* Database.migrate).toEqual([]);
      const accounts = yield* sql`SELECT name FROM accounts`;
      expect(accounts).toEqual([{ name: "Ada" }]);
    }),
  );
});
