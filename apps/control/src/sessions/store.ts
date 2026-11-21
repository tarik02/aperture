import type { DesiredState, ObservedState } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Observation, Session } from "./schemas.ts";

export interface NewSession {
  readonly id: string;
  readonly accountId: string;
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

export interface SessionDescription {
  readonly label?: string | null | undefined;
  readonly tags?: Readonly<Record<string, string>> | undefined;
}

/** Where the records of sessions are kept: whose each is, where it runs, how it was last seen. */
export interface SessionsStoreShape {
  readonly insert: (session: NewSession) => Effect.Effect<Session>;
  readonly find: (id: string) => Effect.Effect<Option.Option<Session>>;
  readonly list: () => Effect.Effect<ReadonlyArray<Session>>;
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
  readonly delete: (id: string) => Effect.Effect<void>;
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
