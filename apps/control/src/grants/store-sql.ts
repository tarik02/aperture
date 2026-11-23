import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "../store/rows.ts";
import { Client, Grant } from "./schemas.ts";
import {
  GrantsStore,
  type NewClient,
  type NewCode,
  type NewGrant,
  type NewToken,
} from "./store.ts";

const Code = Schema.Struct({
  grantId: Schema.String,
  clientId: Schema.String,
  redirectUri: Schema.String,
  codeChallenge: Schema.String,
});

const Spent = Schema.Struct({ id: Schema.String, spentAt: Schema.NullOr(Schema.Date) });

/** Grants in the SQL database. */
export const makeGrantsStore = Effect.fn("GrantsStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const grants = sql.literal(`
    SELECT oauth_grants.*, oauth_clients.name AS client_name
    FROM oauth_grants
    JOIN oauth_clients ON oauth_clients.id = oauth_grants.client_id
  `);

  const insertClient = Effect.fn("GrantsStore.insertClient")(function* (client: NewClient) {
    return yield* sql`
      INSERT INTO oauth_clients (id, name, redirect_uris, created_at)
      VALUES (
        ${client.id}, ${client.name}, ${JSON.stringify(client.redirectUris)}::jsonb,
        ${client.createdAt}
      )
      RETURNING *
    `.pipe(one(Client));
  });

  const findClient = Effect.fn("GrantsStore.findClient")(function* (id: string) {
    return yield* sql`SELECT * FROM oauth_clients WHERE id::text = ${id}`.pipe(first(Client));
  });

  const deleteClientsNeverGranted = Effect.fn("GrantsStore.deleteClientsNeverGranted")(function* (
    before: Date,
  ) {
    yield* sql`
      DELETE FROM oauth_clients WHERE granted_at IS NULL AND created_at < ${before}
    `.pipe(done);
  });

  const insertGrant = Effect.fn("GrantsStore.insertGrant")(function* (
    grant: NewGrant,
    code: NewCode,
  ) {
    yield* Effect.gen(function* () {
      // First, and whether or not it was granted before: this holds the app's row, so of
      // two grants given at once the second waits here and replaces the first, where it
      // would have found none to replace and been refused as a second of the pair.
      yield* sql`
        UPDATE oauth_clients SET granted_at = COALESCE(granted_at, ${grant.createdAt})
        WHERE id = ${grant.clientId}
      `.pipe(done);
      yield* sql`
        DELETE FROM oauth_grants
        WHERE account_id = ${grant.accountId} AND client_id = ${grant.clientId}
      `.pipe(done);
      yield* sql`
        INSERT INTO oauth_grants (id, account_id, client_id, scopes, resources, created_at)
        VALUES (
          ${grant.id}, ${grant.accountId}, ${grant.clientId},
          ${JSON.stringify(grant.scopes)}::jsonb,
          ${grant.resources === null ? null : JSON.stringify(grant.resources)}::jsonb,
          ${grant.createdAt}
        )
      `.pipe(done);
      yield* sql`
        INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at)
        VALUES (
          ${code.codeHash}, ${code.grantId}, ${code.redirectUri}, ${code.codeChallenge},
          ${code.expiresAt}
        )
      `.pipe(done);
    }).pipe(sql.withTransaction, Effect.orDie);
  });

  const listGrants = Effect.fn("GrantsStore.listGrants")(function* (accountId: string) {
    return yield* sql`
      ${grants} WHERE oauth_grants.account_id = ${accountId}
      ORDER BY oauth_grants.created_at, oauth_grants.id
    `.pipe(all(Grant));
  });

  const findGrant = Effect.fn("GrantsStore.findGrant")(function* (id: string) {
    return yield* sql`${grants} WHERE oauth_grants.id::text = ${id}`.pipe(first(Grant));
  });

  const deleteGrant = Effect.fn("GrantsStore.deleteGrant")(function* (id: string) {
    yield* sql`DELETE FROM oauth_grants WHERE id = ${id}`.pipe(done);
  });

  const takeCode = Effect.fn("GrantsStore.takeCode")(function* (codeHash: string, now: Date) {
    return yield* sql`
      DELETE FROM oauth_codes
      USING oauth_grants
      WHERE oauth_codes.code_hash = ${codeHash}
        AND oauth_codes.expires_at > ${now}
        AND oauth_grants.id = oauth_codes.grant_id
      RETURNING
        oauth_codes.grant_id, oauth_grants.client_id, oauth_codes.redirect_uri,
        oauth_codes.code_challenge
    `.pipe(first(Code));
  });

  const insertToken = Effect.fn("GrantsStore.insertToken")(function* (token: NewToken) {
    yield* sql`
      INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at)
      VALUES (${token.tokenHash}, ${token.grantId}, ${token.kind}, ${token.expiresAt})
    `.pipe(done);
  });

  const takeRefreshToken = Effect.fn("GrantsStore.takeRefreshToken")(function* (
    tokenHash: string,
    now: Date,
  ) {
    // One statement: the second half reads the table as it was before the first half
    // wrote, so a token answers as fresh or as spent, and never as both.
    const taken = yield* sql`
      WITH fresh AS (
        UPDATE oauth_tokens SET spent_at = ${now}
        WHERE token_hash = ${tokenHash} AND kind = 'refresh' AND expires_at > ${now}
          AND spent_at IS NULL
        RETURNING grant_id
      )
      SELECT grant_id AS id, NULL::timestamptz AS spent_at FROM fresh
      UNION ALL
      SELECT grant_id, spent_at FROM oauth_tokens
      WHERE token_hash = ${tokenHash} AND kind = 'refresh' AND expires_at > ${now}
        AND spent_at IS NOT NULL
    `.pipe(first(Spent));
    if (Option.isNone(taken)) {
      return Option.none();
    }
    const { spentAt } = taken.value;
    return Option.map(yield* findGrant(taken.value.id), (grant) => ({ grant, spentAt }));
  });

  const findByAccessToken = Effect.fn("GrantsStore.findByAccessToken")(function* (
    tokenHash: string,
    now: Date,
  ) {
    return yield* sql`
      ${grants}
      JOIN oauth_tokens ON oauth_tokens.grant_id = oauth_grants.id
      WHERE oauth_tokens.token_hash = ${tokenHash}
        AND oauth_tokens.kind = 'access'
        AND oauth_tokens.expires_at > ${now}
    `.pipe(first(Grant));
  });

  const findByToken = Effect.fn("GrantsStore.findByToken")(function* (
    tokenHash: string,
    now: Date,
  ) {
    return yield* sql`
      ${grants}
      JOIN oauth_tokens ON oauth_tokens.grant_id = oauth_grants.id
      WHERE oauth_tokens.token_hash = ${tokenHash}
        AND oauth_tokens.expires_at > ${now}
        AND oauth_tokens.spent_at IS NULL
    `.pipe(first(Grant));
  });

  const deleteExpired = Effect.fn("GrantsStore.deleteExpired")(function* (now: Date) {
    yield* sql`DELETE FROM oauth_codes WHERE expires_at <= ${now}`.pipe(done);
    yield* sql`DELETE FROM oauth_tokens WHERE expires_at <= ${now}`.pipe(done);
  });

  return GrantsStore.of({
    insertClient,
    findClient,
    deleteClientsNeverGranted,
    insertGrant,
    listGrants,
    findGrant,
    deleteGrant,
    takeCode,
    insertToken,
    takeRefreshToken,
    findByAccessToken,
    findByToken,
    deleteExpired,
  });
});

export const layer = Layer.effect(GrantsStore, makeGrantsStore());
