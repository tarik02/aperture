import * as Schema from "effect/Schema";

/** What a member does in a workspace: an admin also says who its members are. */
export const WorkspaceRole = Schema.Literals(["member", "admin"]);
export type WorkspaceRole = typeof WorkspaceRole.Type;

/** Where accounts keep sessions and snapshots together: what is a workspace's is all its members'. */
export const Workspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromDate,
});
export type Workspace = typeof Workspace.Type;

export const WorkspaceMember = Schema.Struct({
  accountId: Schema.String,
  /** The account's name, for whoever reads the list. */
  name: Schema.String,
  role: WorkspaceRole,
});
export type WorkspaceMember = typeof WorkspaceMember.Type;

/** A workspace as one of its members has it. */
export interface Membership {
  readonly workspace: Workspace;
  readonly role: WorkspaceRole;
}
