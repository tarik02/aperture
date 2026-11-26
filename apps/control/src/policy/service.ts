import type {
  Caller,
  SettingEffective,
  SettingEntry,
  SettingKey,
  SettingView,
} from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type {
  AccountNotFound,
  Forbidden,
  SessionNotFound,
  SettingInvalid,
  SettingOutOfBounds,
  WorkspaceNotFound,
} from "../errors.ts";

/**
 * Where settings are said: the deployment, a workspace, a person wherever they are, a
 * person as a member of a workspace, and one session. A person is the caller where none
 * is named.
 */
export type Target =
  | { readonly level: "instance" }
  | { readonly level: "workspace"; readonly id: string }
  | { readonly level: "account"; readonly accountId: string | null }
  | { readonly level: "member"; readonly workspaceId: string; readonly accountId: string | null }
  | { readonly level: "session"; readonly id: string };

/** What a session is had by, which says whose settings it has: those on the way to it. */
export interface Place {
  readonly workspaceId: string | null;
  readonly accountId: string | null;
  /** None for one that is yet to be made. */
  readonly sessionId: string | null;
  /** Whether the session is pinned, which some settings come to otherwise for. */
  readonly pinned: boolean;
}

/** Every setting as it comes to for something. */
export type Effective = { readonly [K in SettingKey]: SettingEffective };

/** What refuses a level's settings to be seen or changed. */
export type TargetError = Forbidden | WorkspaceNotFound | SessionNotFound | AccountNotFound;

/**
 * The settings a session has, said at each level from the deployment down to the
 * session, each level held to the bounds of those above it.
 */
export interface PolicyShape {
  /** Every setting as a level has it, for a caller who sees that level. */
  readonly views: (
    caller: Caller,
    target: Target,
  ) => Effect.Effect<ReadonlyArray<SettingView>, TargetError>;
  /** Says what a level says of a setting, in place of what it said. */
  readonly set: (
    caller: Caller,
    target: Target,
    key: SettingKey,
    entry: SettingEntry,
  ) => Effect.Effect<SettingView, TargetError | SettingInvalid | SettingOutOfBounds>;
  /** Has a level say nothing of a setting. */
  readonly clear: (
    caller: Caller,
    target: Target,
    key: SettingKey,
  ) => Effect.Effect<SettingView, TargetError>;
  /** Every setting as it comes to for what a session is had by. */
  readonly of: (place: Place) => Effect.Effect<Effective>;
  /** What every setting comes to for each of many: read at once, and resolved after. */
  readonly snapshot: () => Effect.Effect<(place: Place) => Effective>;
  /** A word each time a setting may have come to something else. */
  readonly changes: Stream.Stream<void>;
  /** Tells whoever follows the changes that something settings depend on changed. */
  readonly touched: () => Effect.Effect<void>;
}

export class Policy extends Context.Service<Policy, PolicyShape>()(
  "@aperture-browser/control/Policy",
) {}
