import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as Str from "effect/String";
import { Settings } from "./settings/service.ts";

const statements = (all: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // One at a time: a prepared statement is one statement.
    yield* Effect.forEach(all, (statement) => sql.unsafe(statement), { discard: true });
  });

/**
 * Every table names its owner `account_id`, so that what an account shares with others
 * later is said beside it and not in its place.
 */
const initial = statements([
  `CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    admin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE api_tokens (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL
  )`,
  `CREATE INDEX api_tokens_account_id ON api_tokens (account_id)`,
  `CREATE TABLE registration_tokens (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL
  )`,
  // The control plane has to send the operator token to the node, so no digest of it
  // would do: it is sealed with the master key, which is not here.
  `CREATE TABLE nodes (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE,
    internal_url text NOT NULL,
    balancer_url text,
    public_url text,
    operator_token_sealed text NOT NULL,
    offers jsonb,
    registration_token_id uuid REFERENCES registration_tokens (id) ON DELETE SET NULL,
    registered_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL
  )`,
  `CREATE TABLE snapshots (
    id text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts (id),
    name text,
    created_at timestamptz NOT NULL
  )`,
  `CREATE INDEX snapshots_account_id ON snapshots (account_id)`,
  // A session's snapshot is named and not referenced: executors know snapshots the
  // control plane was never told of.
  `CREATE TABLE sessions (
    id text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts (id),
    node_id uuid REFERENCES nodes (id) ON DELETE SET NULL,
    desired_state text NOT NULL CHECK (desired_state IN ('running', 'suspended')),
    observed_state text NOT NULL CHECK (
      observed_state IN ('suspended', 'starting', 'running', 'suspending', 'failed', 'gone')
    ),
    failure text,
    unreachable_since timestamptz,
    snapshot_id text,
    created_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL
  )`,
  `CREATE INDEX sessions_account_id ON sessions (account_id)`,
  `CREATE INDEX sessions_node_id ON sessions (node_id)`,
]);

/** Brings the database to what this program expects; what was applied before is left alone. */
export const migrate = Migrator.make({})({
  loader: Migrator.fromRecord({
    "0001_initial": initial,
  }),
  table: "control_migrations",
});

const client = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* Settings;
    return PgClient.layer({
      url: settings.databaseUrl,
      applicationName: "aperture-control",
      transformResultNames: Str.snakeToCamel,
    });
  }),
);

/** The database, migrated before anything is asked of it. */
export const layer = Layer.effectDiscard(migrate).pipe(Layer.provideMerge(client));
