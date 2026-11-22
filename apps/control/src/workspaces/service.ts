import type { Caller } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AccountNotFound, Forbidden, WorkspaceInUse, WorkspaceNotFound } from "../errors.ts";
import type { Membership, Workspace, WorkspaceMember, WorkspaceRole } from "./schemas.ts";

/** A workspace as its caller has it: `role` is none for an admin who is no member. */
export interface Joined {
  readonly workspace: Workspace;
  readonly role: WorkspaceRole | null;
}

/** Workspaces, and who is in each. */
export interface WorkspacesShape {
  /** A new workspace, whose first member and admin is the caller's account. */
  readonly create: (caller: Caller, name: string) => Effect.Effect<Joined, Forbidden>;
  /** The workspaces the caller is in; all of them for an admin. */
  readonly list: (caller: Caller) => Effect.Effect<ReadonlyArray<Joined>>;
  /** The workspaces an account is in, for telling what is the account's to reach. */
  readonly of: (accountId: string) => Effect.Effect<ReadonlyArray<Membership>>;
  /** The workspaces an account that is there is in, for an admin who looks at the account. */
  readonly ofAccount: (
    accountId: string,
  ) => Effect.Effect<ReadonlyArray<Membership>, AccountNotFound>;
  readonly rename: (
    caller: Caller,
    id: string,
    name: string,
  ) => Effect.Effect<Joined, WorkspaceNotFound | Forbidden>;
  /** Removes a workspace that has no sessions and no snapshots left. */
  readonly delete: (
    caller: Caller,
    id: string,
  ) => Effect.Effect<void, WorkspaceNotFound | Forbidden | WorkspaceInUse>;
  readonly members: (
    caller: Caller,
    id: string,
  ) => Effect.Effect<ReadonlyArray<WorkspaceMember>, WorkspaceNotFound>;
  /** Puts an account into the workspace, or changes what it does there. */
  readonly admit: (
    caller: Caller,
    id: string,
    accountId: string,
    role: WorkspaceRole,
  ) => Effect.Effect<void, WorkspaceNotFound | Forbidden | AccountNotFound>;
  /** Takes an account out of the workspace. What it made there stays the workspace's. */
  readonly dismiss: (
    caller: Caller,
    id: string,
    accountId: string,
  ) => Effect.Effect<void, WorkspaceNotFound | Forbidden>;
}

export class Workspaces extends Context.Service<Workspaces, WorkspacesShape>()(
  "@aperture-browser/control/Workspaces",
) {}
