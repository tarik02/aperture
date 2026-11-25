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
      expect(applied.map(([, name]) => name)).toEqual(["initial", "v1_credentials"]);

      const tables = yield* sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
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
        "v1_api_tokens",
        "workspace_members",
        "workspaces",
      ]);
      // Every table of what is someone's says when a row was deleted, and has a view of
      // those that were not; the others are what is removed for good.
      const marked = yield* sql`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'deleted_at'
          AND table_name NOT LIKE 'live\_%'
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Tables)));
      expect(marked.map((table) => table.table_name).toSorted()).toEqual(
        Database.SOFT_DELETED.toSorted(),
      );
      const views = yield* sql`
        SELECT table_name FROM information_schema.views WHERE table_schema = 'public'
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Tables)));
      expect(views.map((view) => view.table_name).toSorted()).toEqual(
        Database.SOFT_DELETED.map((table) => `live_${table}`).toSorted(),
      );
    }),
  );

  it.effect(
    "a session or a snapshot is of a workspace or names its account, and nothing it names is removed for good",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const maker = "00000000-0000-7000-8000-0000000000a1";
        const team = "00000000-0000-7000-8000-0000000000b1";
        yield* sql`INSERT INTO accounts (id, name, admin, created_at) VALUES (${maker}, 'Maker', false, now())`;
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

        // Nothing goes with a row that is removed for good, so none that is named is.
        expect((yield* Effect.flip(sql`DELETE FROM accounts WHERE id = ${maker}`))._tag).toBe(
          "SqlError",
        );
        expect((yield* Effect.flip(sql`DELETE FROM workspaces WHERE id = ${team}`))._tag).toBe(
          "SqlError",
        );
        yield* sql`DELETE FROM sessions`;
        yield* sql`DELETE FROM snapshots`;
        yield* sql`DELETE FROM workspaces`;
        yield* sql`DELETE FROM accounts`;
      }),
  );

  it.effect("what is deleted is in no view, and what it was known by is another's to have", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const node = (id: string) => sql`
        INSERT INTO nodes (id, name, internal_url, operator_token_sealed, registered_at, last_seen_at)
        VALUES (${id}, 'node-a', 'http://nowhere', 'sealed', now(), now())
      `;
      const first = "00000000-0000-7000-8000-0000000000c1";
      const second = "00000000-0000-7000-8000-0000000000c2";
      yield* node(first);
      expect((yield* Effect.flip(node(second)))._tag).toBe("SqlError");
      // Through the view, as the stores delete: the row stays, and is not seen there again.
      yield* sql`UPDATE live_nodes SET deleted_at = now() WHERE id = ${first}`;
      expect(yield* sql`SELECT id FROM live_nodes`).toEqual([]);
      yield* sql`UPDATE live_nodes SET name = 'renamed' WHERE id = ${first}`;
      yield* node(second);
      expect(yield* sql`SELECT id FROM live_nodes`).toEqual([{ id: second }]);
      expect(yield* sql`SELECT id, name FROM nodes ORDER BY id`).toEqual([
        { id: first, name: "node-a" },
        { id: second, name: "node-a" },
      ]);
      yield* sql`DELETE FROM nodes`;
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
