import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { DesiredState, Observation, ObservedState, Session } from "./schemas.ts";

export interface NewSession {
  readonly id: string;
  readonly accountId: string;
  readonly nodeId: string;
  readonly desiredState: DesiredState;
  readonly observedState: ObservedState;
  readonly failure: string | null;
  readonly snapshotId: string | null;
  readonly createdAt: Date;
  readonly now: Date;
}

/** Where the records of sessions are kept: whose each is, where it runs, how it was last seen. */
export interface SessionsStoreShape {
  readonly insert: (session: NewSession) => Effect.Effect<Session>;
  readonly find: (id: string) => Effect.Effect<Option.Option<Session>>;
  readonly list: () => Effect.Effect<ReadonlyArray<Session>>;
  readonly listOf: (accountId: string) => Effect.Effect<ReadonlyArray<Session>>;
  /** The ids of the sessions that are on a node. */
  readonly on: (nodeId: string) => Effect.Effect<ReadonlyArray<string>>;
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
