import type { Caller } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Forbidden } from "../errors.ts";
import type { Account } from "./schemas.ts";

/** The caller's account, for what is an account's alone to do: make sessions, take snapshots. */
export const accountOf = (caller: Caller): Effect.Effect<Account, Forbidden> =>
  Option.match(caller.account, {
    onNone: () =>
      Effect.fail(
        new Forbidden({ message: "this is an account's to do, and this token is of none" }),
      ),
    onSome: Effect.succeed,
  });

/** Whose something is: a workspace's where it names one, and the account's own otherwise. */
export interface Owned {
  readonly accountId: string;
  readonly workspaceId: string | null;
}

/** A session or a snapshot, as a token's resources name one. */
export interface Resource {
  readonly kind: "sessions" | "snapshots";
  readonly id: string;
}

/**
 * Whether something is the caller's to see and change: what is their own account's, what
 * is of a workspace they are in, and anything for an admin. A token held to resources
 * reaches of that only what they name: the thing itself, or the workspace it is of.
 */
export const reaches = (caller: Caller, owned: Owned, resource?: Resource) => {
  const theirs =
    caller.admin ||
    (owned.workspaceId === null
      ? Option.exists(caller.account, (account) => account.id === owned.accountId)
      : caller.workspaces.some((workspace) => workspace.id === owned.workspaceId));
  if (!theirs || caller.resources === null || resource === undefined) {
    return theirs;
  }
  return (
    caller.resources[resource.kind].includes(resource.id) ||
    (owned.workspaceId !== null && caller.resources.workspaces.includes(owned.workspaceId))
  );
};
