import type { DesiredState } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "../store/rows.ts";
import { type Observation, Session } from "./schemas.ts";
import { type NewSession, type SessionDescription, SessionsStore } from "./store.ts";

const Id = Schema.Struct({ id: Schema.String });

/** The records of sessions in the SQL database. */
export const makeSessionsStore = Effect.fn("SessionsStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insert = Effect.fn("SessionsStore.insert")(function* (session: NewSession) {
    return yield* sql`
      INSERT INTO sessions (
        id, account_id, workspace_id, node_id, desired_state, observed_state, failure, snapshot_id,
        label, tags, created_at, observed_at
      )
      VALUES (
        ${session.id}, ${session.accountId}, ${session.workspaceId}, ${session.nodeId},
        ${session.desiredState},
        ${session.observedState}, ${session.failure}, ${session.snapshotId},
        ${session.label}, ${JSON.stringify(session.tags)}::jsonb,
        ${session.createdAt}, ${session.now}
      )
      RETURNING *
    `.pipe(one(Session));
  });

  const find = Effect.fn("SessionsStore.find")(function* (id: string) {
    return yield* sql`SELECT * FROM live_sessions WHERE id = ${id}`.pipe(first(Session));
  });

  const list = Effect.fn("SessionsStore.list")(function* () {
    return yield* sql`SELECT * FROM live_sessions ORDER BY created_at, id`.pipe(all(Session));
  });

  const listOf = Effect.fn("SessionsStore.listOf")(function* (
    accountId: string,
    workspaceIds: ReadonlyArray<string>,
  ) {
    return yield* sql`
      SELECT * FROM live_sessions
      WHERE ${sql.or([
        sql`(account_id = ${accountId} AND workspace_id IS NULL)`,
        // `IN ()` is no SQL.
        ...(workspaceIds.length === 0 ? [] : [sql`workspace_id IN ${sql.in(workspaceIds)}`]),
      ])}
      ORDER BY created_at, id
    `.pipe(all(Session));
  });

  const on = Effect.fn("SessionsStore.on")(function* (nodeId: string) {
    const rows = yield* sql`SELECT id FROM live_sessions WHERE node_id = ${nodeId}`.pipe(all(Id));
    return rows.map((row) => row.id);
  });

  const describe = Effect.fn("SessionsStore.describe")(function* (
    id: string,
    said: SessionDescription,
  ) {
    if (said.label !== undefined) {
      yield* sql`UPDATE live_sessions SET label = ${said.label} WHERE id = ${id}`.pipe(done);
    }
    if (said.tags !== undefined) {
      yield* sql`
        UPDATE live_sessions SET tags = ${JSON.stringify(said.tags)}::jsonb WHERE id = ${id}
      `.pipe(done);
    }
  });

  const proxyOf = Effect.fn("SessionsStore.proxyOf")(function* (id: string) {
    const row = yield* sql`SELECT proxy_sealed FROM live_sessions WHERE id = ${id}`.pipe(
      first(Schema.Struct({ proxySealed: Schema.NullOr(Schema.String) })),
    );
    return Option.flatMapNullishOr(row, (found) => found.proxySealed);
  });

  const keepProxy = Effect.fn("SessionsStore.keepProxy")(function* (
    id: string,
    sealed: string | null,
  ) {
    yield* sql`UPDATE live_sessions SET proxy_sealed = ${sealed} WHERE id = ${id}`.pipe(done);
  });

  const desire = Effect.fn("SessionsStore.desire")(function* (id: string, state: DesiredState) {
    yield* sql`UPDATE live_sessions SET desired_state = ${state} WHERE id = ${id}`.pipe(done);
  });

  const pin = Effect.fn("SessionsStore.pin")(function* (id: string, pinned: boolean) {
    yield* sql`UPDATE live_sessions SET pinned = ${pinned} WHERE id = ${id}`.pipe(done);
  });

  const pinnedOf = Effect.fn("SessionsStore.pinnedOf")(function* (
    workspaceId: string | null,
    accountId: string | null,
  ) {
    const { count } = yield* sql`
      SELECT count(*)::int AS count FROM live_sessions
      WHERE pinned AND ${
        workspaceId === null
          ? sql`workspace_id IS NULL AND account_id = ${accountId}`
          : sql`workspace_id = ${workspaceId}`
      }
    `.pipe(one(Schema.Struct({ count: Schema.Number })));
    return count;
  });

  const count = Effect.fn("SessionsStore.count")(function* (asked: {
    readonly workspaceId: string | null;
    readonly accountId: string | null;
    readonly running: boolean;
  }) {
    const { count } = yield* sql`
      SELECT count(*)::int AS count FROM live_sessions
      WHERE ${sql.and([
        asked.workspaceId === null
          ? sql`workspace_id IS NULL`
          : sql`workspace_id = ${asked.workspaceId}`,
        ...(asked.accountId === null ? [] : [sql`account_id = ${asked.accountId}`]),
        ...(asked.running ? [sql`desired_state = 'running'`] : []),
      ])}
    `.pipe(one(Schema.Struct({ count: Schema.Number })));
    return count;
  });

  const delete_ = Effect.fn("SessionsStore.delete")(function* (id: string, at: Date) {
    yield* Effect.gen(function* () {
      yield* sql`UPDATE live_sessions SET deleted_at = ${at} WHERE id = ${id}`.pipe(done);
      // Its links lead nowhere, and go with it.
      yield* sql`
        UPDATE live_session_shares SET deleted_at = ${at} WHERE session_id = ${id}
      `.pipe(done);
    }).pipe(sql.withTransaction, Effect.orDie);
  });

  const observe = Effect.fn("SessionsStore.observe")(function* (
    nodeId: string,
    seen: Observation,
    now: Date,
  ) {
    yield* sql`
      UPDATE live_sessions
      SET observed_state = ${seen.state}, failure = ${seen.failure},
        unreachable_since = NULL, observed_at = ${now},
        suspended_since = CASE
          WHEN ${seen.state} = 'suspended' THEN COALESCE(suspended_since, ${now})
        END
      WHERE id = ${seen.id} AND node_id = ${nodeId}
    `.pipe(done);
  });

  const gone = Effect.fn("SessionsStore.gone")(function* (nodeId: string, id: string, now: Date) {
    yield* sql`
      UPDATE live_sessions
      SET node_id = NULL, observed_state = 'gone', unreachable_since = NULL,
        observed_at = ${now}
      WHERE id = ${id} AND node_id = ${nodeId}
    `.pipe(done);
  });

  const unreachable = Effect.fn("SessionsStore.unreachable")(function* (nodeId: string, now: Date) {
    yield* sql`
      UPDATE live_sessions SET unreachable_since = ${now}
      WHERE node_id = ${nodeId} AND unreachable_since IS NULL
    `.pipe(done);
  });

  const unreachableExceptOn = Effect.fn("SessionsStore.unreachableExceptOn")(function* (
    nodeIds: ReadonlyArray<string>,
    now: Date,
  ) {
    yield* sql`
      UPDATE live_sessions SET unreachable_since = ${now}
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
    describe,
    proxyOf,
    keepProxy,
    desire,
    pin,
    pinnedOf,
    count,
    delete: delete_,
    observe,
    gone,
    unreachable,
    unreachableExceptOn,
  });
});

export const layer = Layer.effect(SessionsStore, makeSessionsStore());
