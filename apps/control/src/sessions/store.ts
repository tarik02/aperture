import type { DesiredState, ObservedState } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Observation, Session } from "./schemas.ts";

export interface NewSession {
  readonly id: string;
  /** Who made it: always said of what is of no workspace, which is that account's own. */
  readonly accountId: string | null;
  readonly workspaceId: string | null;
  readonly nodeId: string;
  readonly desiredState: DesiredState;
  readonly observedState: ObservedState;
  readonly failure: string | null;
  readonly snapshotId: string | null;
  readonly label: string | null;
  readonly tags: Readonly<Record<string, string>>;
  readonly createdAt: Date;
  readonly now: Date;
}

/** How many sessions a node has in one desired and observed state. */
export interface StateCount {
  /** The node's name; none for the sessions that are gone from their nodes. */
  readonly node: string | null;
  readonly desiredState: DesiredState;
  readonly observedState: ObservedState;
  readonly count: number;
}

export interface SessionDescription {
  readonly label?: string | null | undefined;
  readonly tags?: Readonly<Record<string, string>> | undefined;
}

/** Since when a session is to go by itself: made, or suspended, before; none for never. */
export interface ExpiryDue {
  readonly createdBefore: Date | null;
  readonly suspendedBefore: Date | null;
}

/** Where the records of sessions are kept: whose each is, where it runs, how it was last seen. */
export interface SessionsStoreShape {
  readonly insert: (session: NewSession) => Effect.Effect<Session>;
  readonly find: (id: string) => Effect.Effect<Option.Option<Session>>;
  readonly list: () => Effect.Effect<ReadonlyArray<Session>>;
  /** How many sessions there are of each node and state; none of a state no session is in. */
  readonly countStates: () => Effect.Effect<ReadonlyArray<StateCount>>;
  /** An account's own sessions, and those of these workspaces. */
  readonly listOf: (
    accountId: string,
    workspaceIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Session>>;
  /** The ids of the sessions that are on a node. */
  readonly on: (nodeId: string) => Effect.Effect<ReadonlyArray<string>>;
  /** Writes what its owner calls a session and tags it with; what is left out stays. */
  readonly describe: (id: string, said: SessionDescription) => Effect.Effect<void>;
  /** A session's routing as it is kept: sealed. None for one that has none. */
  readonly proxyOf: (id: string) => Effect.Effect<Option.Option<string>>;
  readonly keepProxy: (id: string, sealed: string | null) => Effect.Effect<void>;
  readonly desire: (id: string, state: DesiredState) => Effect.Effect<void>;
  readonly pin: (id: string, pinned: boolean) => Effect.Effect<void>;
  /**
   * How many sessions there are of a workspace, or of an account's own without one: of
   * one account alone where it is named, and those asked to run alone where so asked.
   */
  readonly count: (asked: {
    readonly workspaceId: string | null;
    readonly accountId: string | null;
    readonly running: boolean;
  }) => Effect.Effect<number>;
  /**
   * How many sessions of a workspace are pinned, of one account alone where it is named;
   * of an account's own, without one.
   */
  readonly pinnedOf: (
    workspaceId: string | null,
    accountId: string | null,
  ) => Effect.Effect<number>;
  /**
   * Runs what is given in one transaction, alone among all that is run so for the same
   * workspace, or for the same account's own sessions: what counts sessions for a quota
   * and then writes one.
   */
  readonly alone: <A, E, R>(
    scope: { readonly workspaceId: string | null; readonly accountId: string | null },
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Deletes a session's record and its share links: kept, and found by nothing again. */
  readonly delete: (id: string, at: Date) => Effect.Effect<void>;
  /**
   * Deletes a session as `delete` does if it is still due to go by itself when it is
   * deleted: not pinned, and made or suspended before then. None for one that is not.
   */
  readonly expire: (id: string, due: ExpiryDue, at: Date) => Effect.Effect<Option.Option<Session>>;
  /** Takes back a delete made at that time, of a session whose node did not delete it. */
  readonly restore: (id: string, at: Date) => Effect.Effect<void>;
  /** Writes what a node said of a session that is on it; the node is in reach, then. */
  readonly observe: (nodeId: string, seen: Observation, now: Date) => Effect.Effect<void>;
  /** Takes a session off a node that has it no more. */
  readonly gone: (nodeId: string, id: string, now: Date) => Effect.Effect<void>;
  /** Marks the sessions of a node that does not answer, those not marked already. */
  readonly unreachable: (nodeId: string, now: Date) => Effect.Effect<void>;
  /** Marks the sessions of every node but these, those not marked already. */
  readonly unreachableExceptOn: (nodeIds: ReadonlyArray<string>, now: Date) => Effect.Effect<void>;
}

export class SessionsStore extends Context.Service<SessionsStore, SessionsStoreShape>()(
  "@aperture-browser/control/SessionsStore",
) {}
