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
  Install,
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
  /** v1's `cold_root`, where its snapshots and its sessions' files are. */
  readonly coldRoot: string;
  /** v1's `store_root`, where its sessions' profiles are. */
  readonly storeRoot: string;
}

/** Where v1 keeps what has an id below a root: two levels of the id's first bytes. */
const bucketed = (root: string, of: string, id: string) => {
  const hex = id.replaceAll("-", "");
  return `${root}/${of}/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${id}`;
};

/** Where v1 keeps a snapshot's profile below its cold root. */
export const profileOf = (coldRoot: string, id: string) =>
  `${bucketed(coldRoot, "snapshots", id)}/profile`;

/**
 * Where v1 keeps a session: what its browser wrote above its snapshot and where the two
 * are mounted as one below the store root, and its files below the cold root.
 */
export const sessionOf = (location: V1Location, id: string) => ({
  upper: `${bucketed(location.storeRoot, "sessions", id)}/upper`,
  merged: `${bucketed(location.storeRoot, "sessions", id)}/merged`,
  files: `${bucketed(location.coldRoot, "sessions", id)}/files`,
});

/** Where something is mounted, as the fifth field of a line of `mountinfo` tells it. */
const mountPoints = (mountinfo: string) =>
  new Set(
    mountinfo
      .split("\n")
      .flatMap((line) => line.split(" ").slice(4, 5))
      // A space, a tab, a newline and a backslash are written as their octal numbers.
      .map((point) =>
        point.replaceAll(/\\([0-7]{3})/gu, (_, octal: string) =>
          String.fromCodePoint(Number.parseInt(octal, 8)),
        ),
      ),
  );

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
      const sessions = yield* rows(
        Session,
        sql`SELECT id, tenant_id, base_snapshot_id, label, status, created_at, expired_at,
                 proxy_config
          FROM sessions ORDER BY created_at, id`,
      );
      const [install] = yield* rows(
        Install,
        sql`SELECT install_id, created_at FROM install_identity`,
      );
      if (install === undefined) {
        return yield* unusable("it does not say which installation it is of");
      }
      const where = {
        ...location,
        coldRoot: path.resolve(location.coldRoot),
        storeRoot: path.resolve(location.storeRoot),
      };
      const there = (entry: string) => fs.exists(entry).pipe(Effect.orElseSucceed(() => false));
      // Nothing is mounted where what is mounted cannot be told: on no Linux, v1 ran nothing.
      const mounted = mountPoints(
        yield* fs.readFileString("/proc/self/mountinfo").pipe(Effect.orElseSucceed(() => "")),
      );
      return {
        tenants: yield* rows(Tenant, sql`SELECT * FROM tenants ORDER BY created_at, id`),
        users: yield* rows(
          User,
          sql`SELECT users.*, user_passwords.password_hash, totp_credentials.secret AS totp_secret
            FROM users
            LEFT JOIN user_passwords ON user_passwords.user_id = users.id
            LEFT JOIN totp_credentials ON totp_credentials.user_id = users.id
            ORDER BY users.created_at, users.id`,
        ),
        memberships: yield* rows(
          Membership,
          sql`SELECT tenant_id, user_id, scopes_json AS scopes, created_at
            FROM tenant_memberships ORDER BY created_at, tenant_id, user_id`,
        ),
        tokens: yield* rows(
          ApiToken,
          sql`SELECT id, authority_type, tenant_id, name, token_hash, scopes_json AS scopes, created_at,
                   created_by_type, created_by_id, resource_mode, expires_at, revoked_at
            FROM api_tokens ORDER BY created_at, id`,
        ),
        grants: yield* rows(ResourceGrant, sql`SELECT * FROM api_token_resource_grants`),
        snapshots: yield* Effect.forEach(
          snapshots,
          Effect.fn(function* (snapshot) {
            const profile = profileOf(where.coldRoot, snapshot.id);
            return { ...snapshot, profile: (yield* there(profile)) ? profile : null };
          }),
        ),
        snapshotTags: yield* rows(
          Tag,
          sql`SELECT snapshot_id AS of, key, value FROM snapshot_tags`,
        ),
        sessions: yield* Effect.forEach(
          sessions,
          Effect.fn(function* (session) {
            const { upper, merged, files } = sessionOf(where, session.id);
            return {
              ...session,
              upper: (yield* there(upper)) ? upper : null,
              files: (yield* there(files)) ? files : null,
              mounted: mounted.has(merged),
            };
          }),
        ),
        sessionTags: yield* rows(Tag, sql`SELECT session_id AS of, key, value FROM session_tags`),
        install,
        withoutAHome: yield* counted(sql),
      };
    },
    Effect.scoped,
    Effect.provide(Reactivity.layer),
  );

  return V1Source.of({ read });
});

export const layer = (location: V1Location) => Layer.effect(V1Source, makeV1Source(location));
