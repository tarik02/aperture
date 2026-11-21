import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "../store/rows.ts";
import { type DesiredState, type Observation, Session } from "./schemas.ts";
import { type NewSession, SessionsStore } from "./store.ts";

const Id = Schema.Struct({ id: Schema.String });

/** The records of sessions in the SQL database. */
export const makeSessionsStore = Effect.fn("SessionsStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insert = Effect.fn("SessionsStore.insert")(function* (session: NewSession) {
    return yield* sql`
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
    `.pipe(one(Session));
  });

  const find = Effect.fn("SessionsStore.find")(function* (id: string) {
    return yield* sql`SELECT * FROM sessions WHERE id = ${id}`.pipe(first(Session));
  });

  const list = Effect.fn("SessionsStore.list")(function* () {
    return yield* sql`SELECT * FROM sessions ORDER BY created_at, id`.pipe(all(Session));
  });

  const listOf = Effect.fn("SessionsStore.listOf")(function* (accountId: string) {
    return yield* sql`
      SELECT * FROM sessions WHERE account_id = ${accountId} ORDER BY created_at, id
    `.pipe(all(Session));
  });

  const on = Effect.fn("SessionsStore.on")(function* (nodeId: string) {
    const rows = yield* sql`SELECT id FROM sessions WHERE node_id = ${nodeId}`.pipe(all(Id));
    return rows.map((row) => row.id);
  });

  const desire = Effect.fn("SessionsStore.desire")(function* (id: string, state: DesiredState) {
    yield* sql`UPDATE sessions SET desired_state = ${state} WHERE id = ${id}`.pipe(done);
  });

  const delete_ = Effect.fn("SessionsStore.delete")(function* (id: string) {
    yield* sql`DELETE FROM sessions WHERE id = ${id}`.pipe(done);
  });

  const observe = Effect.fn("SessionsStore.observe")(function* (
    nodeId: string,
    seen: Observation,
    now: Date,
  ) {
    yield* sql`
      UPDATE sessions
      SET observed_state = ${seen.state}, failure = ${seen.failure},
        unreachable_since = NULL, observed_at = ${now}
      WHERE id = ${seen.id} AND node_id = ${nodeId}
    `.pipe(done);
  });

  const gone = Effect.fn("SessionsStore.gone")(function* (nodeId: string, id: string, now: Date) {
    yield* sql`
      UPDATE sessions
      SET node_id = NULL, observed_state = 'gone', unreachable_since = NULL,
        observed_at = ${now}
      WHERE id = ${id} AND node_id = ${nodeId}
    `.pipe(done);
  });

  const unreachable = Effect.fn("SessionsStore.unreachable")(function* (nodeId: string, now: Date) {
    yield* sql`
      UPDATE sessions SET unreachable_since = ${now}
      WHERE node_id = ${nodeId} AND unreachable_since IS NULL
    `.pipe(done);
  });

  const unreachableExceptOn = Effect.fn("SessionsStore.unreachableExceptOn")(function* (
    nodeIds: ReadonlyArray<string>,
    now: Date,
  ) {
    yield* sql`
      UPDATE sessions SET unreachable_since = ${now}
      WHERE ${sql.and([
        "node_id IS NOT NULL",
        "unreachable_since IS NULL",
        // `NOT IN ()` is no SQL: with no node left out, every session is marked.
        ...(nodeIds.length === 0 ? [] : [sql`node_id NOT IN ${sql.in(nodeIds)}`]),
      ])}
    `.pipe(done);
  });

  return SessionsStore.of({
    insert,
    find,
    list,
    listOf,
    on,
    desire,
    delete: delete_,
    observe,
    gone,
    unreachable,
    unreachableExceptOn,
  });
});

export const layer = Layer.effect(SessionsStore, makeSessionsStore());
