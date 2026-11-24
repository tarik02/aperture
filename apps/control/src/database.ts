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
 * A session or a snapshot names the workspace it is of, where it is of one, and as
 * `account_id` the account that made it. Of no workspace it is that account's own, and
 * always names it. A workspace's is the workspace's whoever made it: the account is told
 * and decides nothing, is none where nobody is known to have made it, and is none again
 * once that account is removed.
 */
const initial = statements([
  `CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    admin boolean NOT NULL DEFAULT false,
    kind text NOT NULL DEFAULT 'service' CHECK (kind IN ('person', 'service')),
    -- Who signs in as the account, as what signs people in knows them; none for a service.
    person_id text UNIQUE,
    email text,
    created_at timestamptz NOT NULL,
    -- A disabled account stays with all that is its own, and is nobody's way in.
    disabled_at timestamptz
  )`,
  `CREATE TABLE workspaces (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE workspace_members (
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('member', 'admin')),
    PRIMARY KEY (workspace_id, account_id)
  )`,
  `CREATE INDEX workspace_members_account_id ON workspace_members (account_id)`,
  `CREATE TABLE api_tokens (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL,
    expires_at timestamptz,
    revoked_at timestamptz,
    scopes jsonb NOT NULL,
    resources jsonb
  )`,
  `CREATE INDEX api_tokens_account_id ON api_tokens (account_id)`,
  // A registration token that was taken back is kept, so that an admin sees it was, and so
  // that the nodes that registered with it are still known to have.
  `CREATE TABLE registration_tokens (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL,
    revoked_at timestamptz
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
    last_seen_at timestamptz NOT NULL,
    -- When it was noted silent: once, until it is heard from again.
    silent_at timestamptz
  )`,
  // The session a snapshot was taken of is named and not referenced: it may be deleted,
  // and the snapshot stays.
  `CREATE TABLE snapshots (
    id text PRIMARY KEY,
    account_id uuid REFERENCES accounts (id) ON DELETE SET NULL,
    workspace_id uuid REFERENCES workspaces (id),
    CHECK (account_id IS NOT NULL OR workspace_id IS NOT NULL),
    name text,
    description text,
    tags jsonb NOT NULL DEFAULT '{}',
    session_id text,
    node_id uuid REFERENCES nodes (id) ON DELETE SET NULL,
    shared boolean NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE INDEX snapshots_account_id ON snapshots (account_id)`,
  // A session's snapshot is named and not referenced: executors know snapshots the
  // control plane was never told of.
  `CREATE TABLE sessions (
    id text PRIMARY KEY,
    account_id uuid REFERENCES accounts (id) ON DELETE SET NULL,
    workspace_id uuid REFERENCES workspaces (id),
    CHECK (account_id IS NOT NULL OR workspace_id IS NOT NULL),
    node_id uuid REFERENCES nodes (id) ON DELETE SET NULL,
    desired_state text NOT NULL CHECK (desired_state IN ('running', 'suspended')),
    observed_state text NOT NULL CHECK (
      observed_state IN ('suspended', 'starting', 'running', 'suspending', 'failed', 'gone')
    ),
    failure text,
    unreachable_since timestamptz,
    snapshot_id text,
    label text,
    tags jsonb NOT NULL DEFAULT '{}',
    -- Its routing names proxies with their credentials, so it is sealed as a secret is.
    proxy_sealed text,
    created_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL
  )`,
  `CREATE INDEX sessions_account_id ON sessions (account_id)`,
  `CREATE INDEX sessions_node_id ON sessions (node_id)`,
  `CREATE INDEX sessions_workspace_id ON sessions (workspace_id)`,
  `CREATE INDEX snapshots_workspace_id ON snapshots (workspace_id)`,
  // An app registers itself, and nobody is asked first: it is nothing until a person
  // gives it a grant. One that was given a grant once is kept though the grant was taken
  // back: it may ask again as what it registered as. One that never was is forgotten after
  // a while.
  `CREATE TABLE oauth_clients (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    redirect_uris jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    granted_at timestamptz
  )`,
  `CREATE TABLE oauth_grants (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    client_id uuid NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
    scopes jsonb NOT NULL,
    resources jsonb,
    created_at timestamptz NOT NULL,
    UNIQUE (account_id, client_id)
  )`,
  `CREATE TABLE oauth_codes (
    code_hash text PRIMARY KEY,
    grant_id uuid NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    expires_at timestamptz NOT NULL
  )`,
  `CREATE TABLE oauth_tokens (
    token_hash text PRIMARY KEY,
    grant_id uuid NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
    expires_at timestamptz NOT NULL,
    spent_at timestamptz
  )`,
  `CREATE INDEX oauth_tokens_grant_id ON oauth_tokens (grant_id)`,
  // A link's secret is kept as its digest: whoever reads the database gets into no session.
  `CREATE TABLE session_shares (
    id uuid PRIMARY KEY,
    session_id text NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    name text NOT NULL,
    role text NOT NULL CHECK (role IN ('watch', 'control')),
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL,
    expires_at timestamptz,
    last_used_at timestamptz
  )`,
  `CREATE INDEX session_shares_session_id ON session_shares (session_id)`,
  // An event names what it is about and references nothing: it stays when that is gone.
  `CREATE TABLE events (
    id uuid PRIMARY KEY,
    occurred_at timestamptz NOT NULL,
    kind text NOT NULL,
    actor_kind text NOT NULL,
    actor_id text,
    actor_name text,
    resource_kind text,
    resource_id text,
    resource_label text,
    owner_id text,
    workspace_id text,
    address text,
    detail jsonb NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX events_occurred_at ON events (occurred_at DESC, id DESC)`,
  `CREATE INDEX events_actor_id ON events (actor_id, occurred_at DESC)`,
  `CREATE INDEX events_owner_id ON events (owner_id, occurred_at DESC)`,
  `CREATE INDEX events_workspace_id ON events (workspace_id, occurred_at DESC)`,
  `CREATE INDEX events_resource ON events (resource_kind, resource_id, occurred_at DESC)`,
  // A provider's client secret is sent to the provider, so no digest of it would do: it is
  // sealed as a node's operator token is. People who came through a provider name it and
  // reference nothing: it may be removed, and they stay.
  `CREATE TABLE providers (
    id text PRIMARY KEY,
    name text NOT NULL,
    issuer text NOT NULL,
    client_id text NOT NULL,
    client_secret_sealed text NOT NULL,
    scopes jsonb NOT NULL,
    provision boolean NOT NULL,
    domains jsonb NOT NULL,
    enabled boolean NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    kind text NOT NULL,
    -- A provider that speaks OAuth 2.0 alone has no issuer to say how it is reached:
    -- where it is asked is kept with it.
    endpoints jsonb,
    -- Which provider's mark one is shown with is said by whoever adds it, and kept as
    -- said: nothing tells it from where a provider is reached.
    icon text
  )`,
  // The count is what tells every program on this database that the providers are not
  // what it last read.
  `CREATE TABLE providers_revision (
    only_one boolean PRIMARY KEY DEFAULT true CHECK (only_one),
    revision bigint NOT NULL
  )`,
  `INSERT INTO providers_revision (revision) VALUES (0)`,
]);

/** Brings the database to what this program expects; what was applied before is left alone. */
export const migrate = Migrator.make({})({
  loader: Migrator.fromRecord({ "0001_initial": initial }),
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
