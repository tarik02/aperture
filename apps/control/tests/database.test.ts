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
      expect(applied.map(([, name]) => name)).toEqual(["initial"]);

      const tables = yield* sql`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Tables)));
      expect(tables.map((table) => table.table_name).toSorted()).toEqual([
        "accounts",
        "api_tokens",
        "control_migrations",
        "events",
        "nodes",
        "oauth_clients",
        "oauth_codes",
        "oauth_grants",
        "oauth_tokens",
        "providers",
        "providers_revision",
        "registration_tokens",
        "session_shares",
        "sessions",
        "snapshots",
        "workspace_members",
        "workspaces",
      ]);
    }),
  );

  it.effect(
    "a session or a snapshot is of a workspace or names its account, and a workspace's outlasts whoever made it",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const maker = "00000000-0000-7000-8000-0000000000a1";
        const owner = "00000000-0000-7000-8000-0000000000a2";
        const team = "00000000-0000-7000-8000-0000000000b1";
        for (const [id, name] of [
          [maker, "Maker"],
          [owner, "Owner"],
        ]) {
          yield* sql`INSERT INTO accounts (id, name, admin, created_at) VALUES (${id}, ${name}, false, now())`;
        }
        yield* sql`INSERT INTO workspaces (id, name, created_at) VALUES (${team}, 'Team', now())`;
        const session = (id: string, account: string | null, workspace: string | null) => sql`
          INSERT INTO sessions (
            id, account_id, workspace_id, desired_state, observed_state, created_at, observed_at
          )
          VALUES (${id}, ${account}, ${workspace}, 'suspended', 'suspended', now(), now())
        `;
        const snapshot = (id: string, account: string | null, workspace: string | null) => sql`
          INSERT INTO snapshots (id, account_id, workspace_id, shared, created_at)
          VALUES (${id}, ${account}, ${workspace}, false, now())
        `;
        // Of no workspace and of no account, it would be nobody's.
        expect((yield* Effect.flip(session("nobodys", null, null)))._tag).toBe("SqlError");
        expect((yield* Effect.flip(snapshot("nobodys", null, null)))._tag).toBe("SqlError");
        yield* session("made", maker, team);
        yield* snapshot("made", maker, team);
        yield* session("unmade", null, team);
        yield* snapshot("unmade", null, team);
        yield* session("own", owner, null);
        yield* snapshot("own", owner, null);

        yield* sql`DELETE FROM accounts WHERE id = ${maker}`;
        expect(
          yield* sql`SELECT id, account_id, workspace_id FROM sessions WHERE id <> 'own' ORDER BY id`,
        ).toEqual([
          { id: "made", account_id: null, workspace_id: team },
          { id: "unmade", account_id: null, workspace_id: team },
        ]);
        expect(yield* sql`SELECT account_id FROM snapshots WHERE id = 'made'`).toEqual([
          { account_id: null },
        ]);
        // What is an account's own keeps the account.
        expect((yield* Effect.flip(sql`DELETE FROM accounts WHERE id = ${owner}`))._tag).toBe(
          "SqlError",
        );
        yield* sql`DELETE FROM sessions`;
        yield* sql`DELETE FROM snapshots`;
        yield* sql`DELETE FROM workspaces`;
        yield* sql`DELETE FROM accounts`;
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
