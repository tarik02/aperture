import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What the levels say of each setting: the deployment as `instance`, with no scope, and a
 * workspace, an account or a session by its id, and an account as a member of a workspace
 * by both, the workspace's first. The scope is named and not referenced: a
 * row of something that is removed for good goes with it, and nothing else holds it.
 *
 * A row's bounds are an admin's of the deployment where it says so, which nobody else
 * changes. A session is pinned, which keeps it from being deleted by itself, and since when
 * it is suspended is kept, for deleting the ones that stay so too long. One its node
 * suspended for sitting idle is asleep. What is said of a member is seen in the workspace
 * by its admins alone, and so is what is recorded of it.
 *
 * What was deleted is found by when, for removing it for good: among the rows that were.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE settings (
      level text NOT NULL
        CHECK (level IN ('instance', 'workspace', 'account', 'member', 'session')),
      scope_id text NOT NULL,
      key text NOT NULL,
      -- JSON, where JSON's null is never or no limit, and none is no value said here.
      value text,
      min double precision,
      max double precision,
      allowed jsonb,
      bounds_by_admin boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (level, scope_id, key)
    )
  `;
  yield* sql`
    ALTER TABLE sessions
      ADD COLUMN pinned boolean NOT NULL DEFAULT false,
      ADD COLUMN suspended_since timestamptz,
      ADD COLUMN asleep boolean NOT NULL DEFAULT false
  `;
  yield* sql`
    UPDATE sessions SET suspended_since = observed_at WHERE observed_state = 'suspended'
  `;
  yield* sql`ALTER TABLE events ADD COLUMN admins_only boolean NOT NULL DEFAULT false`;
  for (const table of [
    "session_shares",
    "sessions",
    "snapshots",
    "api_tokens",
    "oauth_grants",
    "workspace_members",
    "workspaces",
    "registration_tokens",
  ]) {
    yield* sql`
      CREATE INDEX ${sql.literal(`${table}_deleted_at`)} ON ${sql.literal(table)} (deleted_at)
        WHERE deleted_at IS NOT NULL
    `;
  }
  yield* sql`CREATE INDEX workspace_members_workspace_id ON workspace_members (workspace_id)`;
  yield* sql`CREATE INDEX nodes_registration_token_id ON nodes (registration_token_id)`;
  // A view has the columns its table had when it was made.
  yield* sql`CREATE OR REPLACE VIEW live_sessions AS SELECT * FROM sessions WHERE deleted_at IS NULL`;
});
