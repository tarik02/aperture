import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "./rows.ts";

/** What whoever owns the session asked it to be. */
export const DesiredState = Schema.Literals(["running", "suspended"]);
export type DesiredState = typeof DesiredState.Type;

/**
 * What the session's node last said it is. `gone` is a session its node has no more
 * though nobody asked the control plane to delete it.
 */
export const ObservedState = Schema.Literals([
  "suspended",
  "starting",
  "running",
  "suspending",
  "failed",
  "gone",
]);
export type ObservedState = typeof ObservedState.Type;

export const Session = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  /** The node it is on; none for a session that is gone from its node. */
  nodeId: Schema.NullOr(Schema.String),
  desiredState: DesiredState,
  observedState: ObservedState,
  failure: Schema.NullOr(Schema.String),
  /** Since when its node is silent or does not answer; what was observed is from before. */
  unreachableSince: Schema.NullOr(Schema.DateTimeUtcFromDate),
  snapshotId: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromDate,
  observedAt: Schema.DateTimeUtcFromDate,
});
export type Session = typeof Session.Type;

/** What a node says of a session of its own. */
export interface Observation {
  readonly id: string;
  readonly state: ObservedState;
  readonly failure: string | null;
}

export class SessionsStore extends Context.Service<
  SessionsStore,
  {
    readonly insert: (session: {
      readonly id: string;
      readonly accountId: string;
      readonly nodeId: string;
      readonly desiredState: DesiredState;
      readonly observedState: ObservedState;
      readonly failure: string | null;
      readonly snapshotId: string | null;
      readonly createdAt: Date;
      readonly now: Date;
    }) => Effect.Effect<Session>;
    readonly find: (id: string) => Effect.Effect<Option.Option<Session>>;
    readonly list: Effect.Effect<ReadonlyArray<Session>>;
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
    readonly unreachableExceptOn: (
      nodeIds: ReadonlyArray<string>,
      now: Date,
    ) => Effect.Effect<void>;
  }
>()("@aperture-browser/control/SessionsStore") {
  static readonly layer = Layer.effect(
    SessionsStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return SessionsStore.of({
        insert: (session) =>
          sql`
            INSERT INTO sessions (
              id, account_id, node_id, desired_state, observed_state, failure, snapshot_id,
              created_at, observed_at
            )
            VALUES (
              ${session.id}, ${session.accountId}, ${session.nodeId}, ${session.desiredState},
              ${session.observedState}, ${session.failure}, ${session.snapshotId},
              ${session.createdAt}, ${session.now}
            )
            RETURNING *
          `.pipe(one(Session)),
        find: (id) => sql`SELECT * FROM sessions WHERE id = ${id}`.pipe(first(Session)),
        list: sql`SELECT * FROM sessions ORDER BY created_at, id`.pipe(all(Session)),
        listOf: (accountId) =>
          sql`
            SELECT * FROM sessions WHERE account_id = ${accountId} ORDER BY created_at, id
          `.pipe(all(Session)),
        on: (nodeId) =>
          sql`SELECT id FROM sessions WHERE node_id = ${nodeId}`.pipe(
            all(Schema.Struct({ id: Schema.String })),
            Effect.map((rows) => rows.map((row) => row.id)),
          ),
        desire: (id, state) =>
          sql`UPDATE sessions SET desired_state = ${state} WHERE id = ${id}`.pipe(done),
        delete: (id) => sql`DELETE FROM sessions WHERE id = ${id}`.pipe(done),
        observe: (nodeId, seen, now) =>
          sql`
            UPDATE sessions
            SET observed_state = ${seen.state}, failure = ${seen.failure},
              unreachable_since = NULL, observed_at = ${now}
            WHERE id = ${seen.id} AND node_id = ${nodeId}
          `.pipe(done),
        gone: (nodeId, id, now) =>
          sql`
            UPDATE sessions
            SET node_id = NULL, observed_state = 'gone', unreachable_since = NULL,
              observed_at = ${now}
            WHERE id = ${id} AND node_id = ${nodeId}
          `.pipe(done),
        unreachable: (nodeId, now) =>
          sql`
            UPDATE sessions SET unreachable_since = ${now}
            WHERE node_id = ${nodeId} AND unreachable_since IS NULL
          `.pipe(done),
        unreachableExceptOn: (nodeIds, now) =>
          sql`
            UPDATE sessions SET unreachable_since = ${now}
            WHERE ${sql.and([
              "node_id IS NOT NULL",
              "unreachable_since IS NULL",
              // `NOT IN ()` is no SQL: with no node left out, every session is marked.
              ...(nodeIds.length === 0 ? [] : [sql`node_id NOT IN ${sql.in(nodeIds)}`]),
            ])}
          `.pipe(done),
      });
    }),
  );
}
