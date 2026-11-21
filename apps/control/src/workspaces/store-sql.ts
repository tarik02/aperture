import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "../store/rows.ts";
import { Workspace, WorkspaceMember, WorkspaceRole } from "./schemas.ts";
import { type NewWorkspace, WorkspacesStore } from "./store.ts";

const Joined = Schema.Struct({ ...Workspace.fields, role: WorkspaceRole });
const Used = Schema.Struct({ used: Schema.Boolean });

/** Workspaces in the SQL database. */
export const makeWorkspacesStore = Effect.fn("WorkspacesStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insert = Effect.fn("WorkspacesStore.insert")(function* (workspace: NewWorkspace) {
    return yield* sql`
      INSERT INTO workspaces (id, name, created_at)
      VALUES (${workspace.id}, ${workspace.name}, ${workspace.createdAt})
      RETURNING *
    `.pipe(one(Workspace));
  });

  const find = Effect.fn("WorkspacesStore.find")(function* (id: string) {
    return yield* sql`SELECT * FROM workspaces WHERE id = ${id}`.pipe(first(Workspace));
  });

  const list = Effect.fn("WorkspacesStore.list")(function* () {
    return yield* sql`SELECT * FROM workspaces ORDER BY created_at, id`.pipe(all(Workspace));
  });

  const of = Effect.fn("WorkspacesStore.of")(function* (accountId: string) {
    const rows = yield* sql`
      SELECT workspaces.*, workspace_members.role
      FROM workspaces
      JOIN workspace_members ON workspace_members.workspace_id = workspaces.id
      WHERE workspace_members.account_id = ${accountId}
      ORDER BY workspaces.created_at, workspaces.id
    `.pipe(all(Joined));
    return rows.map(({ role, ...workspace }) => ({ workspace, role }));
  });

  const rename = Effect.fn("WorkspacesStore.rename")(function* (id: string, name: string) {
    yield* sql`UPDATE workspaces SET name = ${name} WHERE id = ${id}`.pipe(done);
  });

  const delete_ = Effect.fn("WorkspacesStore.delete")(function* (id: string) {
    const { used } = yield* sql`
      SELECT (
        EXISTS (SELECT 1 FROM sessions WHERE workspace_id = ${id})
        OR EXISTS (SELECT 1 FROM snapshots WHERE workspace_id = ${id})
      ) AS used
    `.pipe(one(Used));
    if (used) {
      return false;
    }
    yield* sql`DELETE FROM workspaces WHERE id = ${id}`.pipe(done);
    return true;
  });

  const members = Effect.fn("WorkspacesStore.members")(function* (id: string) {
    return yield* sql`
      SELECT accounts.id AS account_id, accounts.name, workspace_members.role
      FROM workspace_members
      JOIN accounts ON accounts.id = workspace_members.account_id
      WHERE workspace_members.workspace_id = ${id}
      ORDER BY accounts.created_at, accounts.id
    `.pipe(all(WorkspaceMember));
  });

  const admit = Effect.fn("WorkspacesStore.admit")(function* (
    id: string,
    accountId: string,
    role: WorkspaceRole,
  ) {
    yield* sql`
      INSERT INTO workspace_members (workspace_id, account_id, role)
      VALUES (${id}, ${accountId}, ${role})
      ON CONFLICT (workspace_id, account_id) DO UPDATE SET role = EXCLUDED.role
    `.pipe(done);
  });

  const dismiss = Effect.fn("WorkspacesStore.dismiss")(function* (id: string, accountId: string) {
    yield* sql`
      DELETE FROM workspace_members WHERE workspace_id = ${id} AND account_id = ${accountId}
    `.pipe(done);
  });

  return WorkspacesStore.of({
    insert,
    find,
    list,
    of,
    rename,
    delete: delete_,
    members,
    admit,
    dismiss,
  });
});

export const layer = Layer.effect(WorkspacesStore, makeWorkspacesStore());
