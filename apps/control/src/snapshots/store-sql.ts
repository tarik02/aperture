import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "../store/rows.ts";
import { Snapshot } from "./schemas.ts";
import { type NewSnapshot, SnapshotsStore } from "./store.ts";

/** The records of snapshots in the SQL database. */
export const makeSnapshotsStore = Effect.fn("SnapshotsStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insert = Effect.fn("SnapshotsStore.insert")(function* (snapshot: NewSnapshot) {
    return yield* sql`
      INSERT INTO snapshots (id, account_id, name, session_id, node_id, shared, created_at)
      VALUES (
        ${snapshot.id}, ${snapshot.accountId}, ${snapshot.name}, ${snapshot.sessionId},
        ${snapshot.nodeId}, ${snapshot.shared}, ${snapshot.createdAt}
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

  const listOf = Effect.fn("SnapshotsStore.listOf")(function* (accountId: string) {
    return yield* sql`
      SELECT * FROM snapshots WHERE account_id = ${accountId} ORDER BY created_at, id
    `.pipe(all(Snapshot));
  });

  const delete_ = Effect.fn("SnapshotsStore.delete")(function* (id: string) {
    yield* sql`DELETE FROM snapshots WHERE id = ${id}`.pipe(done);
  });

  return SnapshotsStore.of({ insert, find, list, listOf, delete: delete_ });
});

export const layer = Layer.effect(SnapshotsStore, makeSnapshotsStore());
