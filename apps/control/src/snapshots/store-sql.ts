import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "../store/rows.ts";
import { Snapshot } from "./schemas.ts";
import { type NewSnapshot, type SnapshotDescription, SnapshotsStore } from "./store.ts";

/** The records of snapshots in the SQL database. */
export const makeSnapshotsStore = Effect.fn("SnapshotsStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insert = Effect.fn("SnapshotsStore.insert")(function* (snapshot: NewSnapshot) {
    return yield* sql`
      INSERT INTO snapshots (
        id, account_id, workspace_id, name, description, tags, session_id, node_id, shared, created_at
      )
      VALUES (
        ${snapshot.id}, ${snapshot.accountId}, ${snapshot.workspaceId}, ${snapshot.name},
        ${snapshot.description},
        ${JSON.stringify(snapshot.tags)}::jsonb, ${snapshot.sessionId}, ${snapshot.nodeId},
        ${snapshot.shared}, ${snapshot.createdAt}
      )
      RETURNING *
    `.pipe(one(Snapshot));
  });

  const find = Effect.fn("SnapshotsStore.find")(function* (id: string) {
    return yield* sql`SELECT * FROM snapshots WHERE id = ${id}`.pipe(first(Snapshot));
  });

  const list = Effect.fn("SnapshotsStore.list")(function* () {
    return yield* sql`SELECT * FROM snapshots ORDER BY created_at, id`.pipe(all(Snapshot));
  });

  const listOf = Effect.fn("SnapshotsStore.listOf")(function* (
    accountId: string,
    workspaceIds: ReadonlyArray<string>,
  ) {
    return yield* sql`
      SELECT * FROM snapshots
      WHERE ${sql.or([
        sql`(account_id = ${accountId} AND workspace_id IS NULL)`,
        // `IN ()` is no SQL.
        ...(workspaceIds.length === 0 ? [] : [sql`workspace_id IN ${sql.in(workspaceIds)}`]),
      ])}
      ORDER BY created_at, id
    `.pipe(all(Snapshot));
  });

  const describe = Effect.fn("SnapshotsStore.describe")(function* (
    id: string,
    said: SnapshotDescription,
  ) {
    if (said.name !== undefined) {
      yield* sql`UPDATE snapshots SET name = ${said.name} WHERE id = ${id}`.pipe(done);
    }
    if (said.description !== undefined) {
      yield* sql`UPDATE snapshots SET description = ${said.description} WHERE id = ${id}`.pipe(
        done,
      );
    }
    if (said.tags !== undefined) {
      yield* sql`
        UPDATE snapshots SET tags = ${JSON.stringify(said.tags)}::jsonb WHERE id = ${id}
      `.pipe(done);
    }
  });

  const delete_ = Effect.fn("SnapshotsStore.delete")(function* (id: string) {
    yield* sql`DELETE FROM snapshots WHERE id = ${id}`.pipe(done);
  });

  return SnapshotsStore.of({ insert, find, list, listOf, describe, delete: delete_ });
});

export const layer = Layer.effect(SnapshotsStore, makeSnapshotsStore());
