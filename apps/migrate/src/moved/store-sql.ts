import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { MovedStore } from "./store.ts";

const Moved = Schema.Struct({ key: Schema.String, v2Id: Schema.String });
const There = Schema.Struct({ there: Schema.Boolean });

/**
 * The record in v2's own database, in a table that is this program's and no part of what
 * the control plane reads: once v1 is gone for good it is dropped.
 */
export const makeMovedStore = Effect.fn("MovedStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const prepare = Effect.fn("MovedStore.prepare")(function* () {
    yield* sql`
      CREATE TABLE IF NOT EXISTS moved_from_v1 (
        key text PRIMARY KEY,
        v2_id text NOT NULL,
        moved_at timestamptz NOT NULL
      )
    `;
  }, Effect.orDie);

  const all = Effect.fn("MovedStore.all")(function* () {
    const [found] = yield* sql`SELECT to_regclass('moved_from_v1') IS NOT NULL AS there`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(There))),
    );
    if (found?.there !== true) {
      return new Map<string, string>();
    }
    const rows = yield* sql`SELECT key, v2_id FROM moved_from_v1`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Moved))),
    );
    return new Map(rows.map((row) => [row.key, row.v2Id]));
  }, Effect.orDie);

  const record = Effect.fn("MovedStore.record")(function* (moved: {
    readonly key: string;
    readonly v2Id: string;
    readonly at: Date;
  }) {
    yield* sql`
      INSERT INTO moved_from_v1 (key, v2_id, moved_at)
      VALUES (${moved.key}, ${moved.v2Id}, ${moved.at})
    `;
  }, Effect.orDie);

  return MovedStore.of({ prepare, all, record });
});

export const layer = Layer.effect(MovedStore, makeMovedStore());
