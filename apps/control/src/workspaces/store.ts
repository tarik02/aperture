import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Membership, Workspace, WorkspaceMember, WorkspaceRole } from "./schemas.ts";

export interface NewWorkspace {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

/** Where workspaces and who is in them are kept. */
export interface WorkspacesStoreShape {
  readonly insert: (workspace: NewWorkspace) => Effect.Effect<Workspace>;
  readonly find: (id: string) => Effect.Effect<Option.Option<Workspace>>;
  readonly list: () => Effect.Effect<ReadonlyArray<Workspace>>;
  /** The workspaces an account is in, each with what the account does there. */
  readonly of: (accountId: string) => Effect.Effect<ReadonlyArray<Membership>>;
  readonly rename: (id: string, name: string) => Effect.Effect<void>;
  /** Removes a workspace and who was in it. One that still has sessions or snapshots stays. */
  readonly delete: (id: string) => Effect.Effect<boolean>;
  readonly members: (id: string) => Effect.Effect<ReadonlyArray<WorkspaceMember>>;
  /** Puts an account into a workspace, or changes what it does there. */
  readonly admit: (id: string, accountId: string, role: WorkspaceRole) => Effect.Effect<void>;
  readonly dismiss: (id: string, accountId: string) => Effect.Effect<void>;
}

export class WorkspacesStore extends Context.Service<WorkspacesStore, WorkspacesStoreShape>()(
  "@aperture-browser/control/WorkspacesStore",
) {}
