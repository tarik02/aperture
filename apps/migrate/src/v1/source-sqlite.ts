import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Str from "effect/String";
import { V1DatabaseUnusable, V1SchemaUnexpected } from "../errors.ts";
import {
  ApiToken,
  Count,
  Membership,
  ResourceGrant,
  SCHEMA_VERSION,
  Session,
  Snapshot,
  Tag,
  Tenant,
  User,
  WITHOUT_A_HOME,
  type WithoutAHome,
} from "./schemas.ts";
import { V1Source } from "./source.ts";

export interface V1Location {
  /** v1's `database_path`. */
  readonly database: string;
  /** v1's `cold_root`, where its snapshots are. */
  readonly coldRoot: string;
}

/** Where v1 keeps a snapshot's profile below its cold root: two levels of its id's first bytes. */
export const profileOf = (coldRoot: string, id: string) => {
  const hex = id.replaceAll("-", "");
  return `${coldRoot}/snapshots/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${id}/profile`;
};

export const makeV1Source = Effect.fn("V1Source.make")(function* (location: V1Location) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.resolve(location.database);
  const unusable = (reason: string) => new V1DatabaseUnusable({ file, reason });

  /**
   * The database, opened so that SQLite writes nothing beside it: no journal, no lock, no
   * shared memory. That is right for a file nobody else writes, which `read` makes sure of.
   */
  const opened = SqliteClient.make({
    filename: `file:${encodeURI(file)}?mode=ro&immutable=1`,
    readonly: true,
    disableWAL: true,
    transformResultNames: Str.snakeToCamel,
  });

  const rows = <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    statement: Effect.Effect<ReadonlyArray<unknown>, SqlError>,
  ) =>
    statement.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(schema))),
      Effect.mapError((error) => unusable(error.message)),
    );

  const counted = Effect.fn(function* (sql: SqlClient.SqlClient) {
    const counts: Partial<Record<WithoutAHome, number>> = {};
    for (const table of Object.keys(WITHOUT_A_HOME) as ReadonlyArray<WithoutAHome>) {
      const [row] = yield* rows(Count, sql`SELECT count(*) AS count FROM ${sql(table)}`);
      counts[table] = row?.count ?? 0;
    }
    return counts as Record<WithoutAHome, number>;
  });

  const read = Effect.fn("V1Source.read")(
    function* () {
      if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* unusable("there is no such file");
      }
      // What v1 wrote and has not put into the file yet is in its log, which is not read.
      const log = yield* fs.stat(`${file}-wal`).pipe(Effect.option);
      if (log._tag === "Some" && log.value.size > 0n) {
        return yield* unusable("v1 is running, or did not stop as it should: stop it first");
      }
      const sql = yield* opened;
      const [{ count: version } = { count: 0 }] = yield* rows(
        Count,
        sql`SELECT coalesce(max(version), 0) AS count FROM schema_migrations`,
      );
      if (version !== SCHEMA_VERSION) {
        return yield* new V1SchemaUnexpected({ file, found: version, expected: SCHEMA_VERSION });
      }
      const snapshots = yield* rows(Snapshot, sql`SELECT * FROM snapshots ORDER BY created_at, id`);
      return {
        tenants: yield* rows(Tenant, sql`SELECT * FROM tenants ORDER BY created_at, id`),
        users: yield* rows(User, sql`SELECT * FROM users ORDER BY created_at, id`),
        memberships: yield* rows(
          Membership,
          sql`SELECT tenant_id, user_id, scopes_json AS scopes, created_at
            FROM tenant_memberships ORDER BY created_at, tenant_id, user_id`,
        ),
        tokens: yield* rows(
          ApiToken,
          sql`SELECT id, authority_type, tenant_id, name, scopes_json AS scopes, created_at,
                   created_by_type, created_by_id, resource_mode, expires_at, revoked_at
            FROM api_tokens ORDER BY created_at, id`,
        ),
        grants: yield* rows(ResourceGrant, sql`SELECT * FROM api_token_resource_grants`),
        snapshots: yield* Effect.forEach(
          snapshots,
          Effect.fn(function* (snapshot) {
            const profile = profileOf(path.resolve(location.coldRoot), snapshot.id);
            const there = yield* fs.exists(profile).pipe(Effect.orElseSucceed(() => false));
            return { ...snapshot, profile: there ? profile : null };
          }),
        ),
        snapshotTags: yield* rows(
          Tag,
          sql`SELECT snapshot_id AS of, key, value FROM snapshot_tags`,
        ),
        sessions: yield* rows(
          Session,
          sql`SELECT id, tenant_id, label, status, expired_at FROM sessions ORDER BY created_at, id`,
        ),
        withoutAHome: yield* counted(sql),
      };
    },
    Effect.scoped,
    Effect.provide(Reactivity.layer),
  );

  return V1Source.of({ read });
});

export const layer = (location: V1Location) => Layer.effect(V1Source, makeV1Source(location));
