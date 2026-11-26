import { SettingKey, SettingLevel, SettingValue } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done } from "../store/rows.ts";
import { PolicyStore, type Said, type Scope } from "./store.ts";

const Row = Schema.Struct({
  level: SettingLevel,
  scopeId: Schema.String,
  key: Schema.String,
  value: Schema.NullOr(Schema.String),
  min: Schema.NullOr(Schema.Number),
  max: Schema.NullOr(Schema.Number),
  allowed: Schema.NullOr(Schema.Array(SettingValue)),
  boundsByAdmin: Schema.Boolean,
});

const decodeValue = Schema.decodeUnknownSync(Schema.fromJsonString(SettingValue));
const isKey = Schema.is(SettingKey);

/**
 * What a row says, as a level says it. One of a setting this program no longer has is
 * left out: it was said before the setting went.
 */
const said = (rows: ReadonlyArray<typeof Row.Type>): ReadonlyArray<Said> =>
  rows.flatMap(({ level, scopeId, key, value, min, max, allowed, boundsByAdmin }) =>
    isKey(key)
      ? [
          {
            level,
            scopeId,
            key,
            entry: {
              ...(value === null ? {} : { value: decodeValue(value) }),
              ...(min === null ? {} : { min }),
              ...(max === null ? {} : { max }),
              ...(allowed === null ? {} : { allowed }),
            },
            byAdmin: boundsByAdmin,
          },
        ]
      : [],
  );

/** What the levels say of settings, in the SQL database. */
export const makePolicyStore = Effect.fn("PolicyStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const all_ = Effect.fn("PolicyStore.all")(function* () {
    return said(yield* sql`SELECT * FROM settings`.pipe(all(Row)));
  });

  const of = Effect.fn("PolicyStore.of")(function* (scopes: ReadonlyArray<Scope>) {
    if (scopes.length === 0) {
      return [];
    }
    const rows = yield* sql`
      SELECT * FROM settings
      WHERE ${sql.or(
        scopes.map((scope) => sql`(level = ${scope.level} AND scope_id = ${scope.scopeId})`),
      )}
    `.pipe(all(Row));
    return said(rows);
  });

  const put = Effect.fn("PolicyStore.put")(function* (
    { level, scopeId, key, entry, byAdmin }: Said,
    at: Date,
  ) {
    const value = entry.value === undefined ? null : JSON.stringify(entry.value);
    const allowed = entry.allowed === undefined ? null : JSON.stringify(entry.allowed);
    yield* sql`
      INSERT INTO settings (
        level, scope_id, key, value, min, max, allowed, bounds_by_admin, updated_at
      )
      VALUES (
        ${level}, ${scopeId}, ${key}, ${value}, ${entry.min ?? null}, ${entry.max ?? null},
        ${allowed}::jsonb, ${byAdmin}, ${at}
      )
      ON CONFLICT (level, scope_id, key) DO UPDATE SET
        value = EXCLUDED.value, min = EXCLUDED.min, max = EXCLUDED.max,
        allowed = EXCLUDED.allowed, bounds_by_admin = EXCLUDED.bounds_by_admin,
        updated_at = EXCLUDED.updated_at
    `.pipe(done);
  });

  const remove = Effect.fn("PolicyStore.remove")(function* (scope: Scope, key: string) {
    yield* sql`
      DELETE FROM settings
      WHERE level = ${scope.level} AND scope_id = ${scope.scopeId} AND key = ${key}
    `.pipe(done);
  });

  const purge = Effect.fn("PolicyStore.purge")(function* (before: Date) {
    yield* Effect.gen(function* () {
      yield* sql`DELETE FROM session_shares WHERE deleted_at < ${before}`.pipe(done);
      yield* sql`
        DELETE FROM sessions WHERE deleted_at < ${before}
          AND NOT EXISTS (SELECT 1 FROM session_shares WHERE session_id = sessions.id)
      `.pipe(done);
      yield* sql`DELETE FROM snapshots WHERE deleted_at < ${before}`.pipe(done);
      yield* sql`
        DELETE FROM v1_api_tokens WHERE token_id IN (
          SELECT id FROM api_tokens WHERE deleted_at < ${before}
        )
      `.pipe(done);
      yield* sql`DELETE FROM api_tokens WHERE deleted_at < ${before}`.pipe(done);
      yield* sql`DELETE FROM oauth_grants WHERE deleted_at < ${before}`.pipe(done);
      yield* sql`DELETE FROM workspace_members WHERE deleted_at < ${before}`.pipe(done);
      yield* sql`
        DELETE FROM workspaces WHERE deleted_at < ${before}
          AND NOT EXISTS (SELECT 1 FROM sessions WHERE workspace_id = workspaces.id)
          AND NOT EXISTS (SELECT 1 FROM snapshots WHERE workspace_id = workspaces.id)
          AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = workspaces.id)
      `.pipe(done);
      yield* sql`
        DELETE FROM registration_tokens WHERE deleted_at < ${before}
          AND NOT EXISTS (
            SELECT 1 FROM nodes WHERE registration_token_id = registration_tokens.id
          )
      `.pipe(done);
      // What was said of something deleted stays with its record, and goes with it. One
      // statement for each level, so that each is one join against what is left and not a
      // look for each row: a scope is text, which no index of the ids serves.
      yield* sql`
        DELETE FROM settings WHERE level = 'session'
          AND NOT EXISTS (SELECT 1 FROM sessions WHERE id = settings.scope_id)
      `.pipe(done);
      yield* sql`
        DELETE FROM settings WHERE level = 'workspace'
          AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id::text = settings.scope_id)
      `.pipe(done);
      yield* sql`
        DELETE FROM settings WHERE level = 'member'
          AND NOT EXISTS (
            SELECT 1 FROM workspace_members
            WHERE workspace_id::text || ':' || account_id::text = settings.scope_id
          )
      `.pipe(done);
    }).pipe(sql.withTransaction, Effect.orDie);
  });

  return PolicyStore.of({ all: all_, of, put, remove, purge });
});

export const layer = Layer.effect(PolicyStore, makePolicyStore());
