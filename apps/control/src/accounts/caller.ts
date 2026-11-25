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

/**
 * Whose something is: a workspace's where it names one, whoever made it, and otherwise the
 * own of the account that did.
 */
export interface Owned {
  readonly accountId: string | null;
  readonly workspaceId: string | null;
}

/** A session or a snapshot, as a token's resources name one. */
export interface Resource {
  readonly kind: "sessions" | "snapshots";
  readonly id: string;
}

/** Whether something is the caller's as an account: its own, or of a workspace it is in. */
const held = (caller: Caller, owned: Owned) =>
  owned.workspaceId === null
    ? Option.exists(caller.account, (account) => account.id === owned.accountId)
    : caller.workspaces.some((workspace) => workspace.id === owned.workspaceId);

/** Whether a token held to resources names the thing, or the workspace it is of. */
const named = (caller: Caller, owned: Owned, resource?: Resource) =>
  caller.resources === null ||
  resource === undefined ||
  caller.resources[resource.kind].includes(resource.id) ||
  (owned.workspaceId !== null && caller.resources.workspaces.includes(owned.workspaceId));

/**
 * Whether something is the caller's to see: what is their own account's, what is of a
 * workspace they are in, and anything for an admin. A token held to resources reaches of
 * that only what they name: the thing itself, or the workspace it is of.
 */
export const reaches = (caller: Caller, owned: Owned, resource?: Resource) =>
  (caller.admin || held(caller, owned)) && named(caller, owned, resource);

/**
 * Whether something is the caller's to change, use and act on. An admin sees what is of a
 * workspace they are not in, and acts there once they are in it; what is of no workspace
 * they act on as on their own, there being no workspace to join.
 */
export const actsOn = (caller: Caller, owned: Owned, resource?: Resource) =>
  (held(caller, owned) || (caller.admin && owned.workspaceId === null)) &&
  named(caller, owned, resource);

/** Why an admin who sees what is of a workspace may not act on it. */
export const notTheirs = () =>
  new Forbidden({
    message: "join the workspace to act in it: an admin who is not in it only sees what is there",
  });

/** What a caller asks to do with something: see it, or act on it. */
export type Reach = "read" | "act";
