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

  const insertGrant = Effect.fn("GrantsStore.insertGrant")(function* (grant: NewGrant) {
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

  const insertCode = Effect.fn("GrantsStore.insertCode")(function* (code: NewCode) {
    yield* sql`
      INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at)
      VALUES (
        ${code.codeHash}, ${code.grantId}, ${code.redirectUri}, ${code.codeChallenge},
        ${code.expiresAt}
      )
    `.pipe(done);
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
    const taken = yield* sql`
      DELETE FROM oauth_tokens
      WHERE token_hash = ${tokenHash} AND kind = 'refresh' AND expires_at > ${now}
      RETURNING grant_id AS id
    `.pipe(first(Schema.Struct({ id: Schema.String })));
    return Option.isNone(taken) ? Option.none() : yield* findGrant(taken.value.id);
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

  return GrantsStore.of({
    insertClient,
    findClient,
    insertGrant,
    listGrants,
    findGrant,
    deleteGrant,
    insertCode,
    takeCode,
    insertToken,
    takeRefreshToken,
    findByAccessToken,
  });
});

export const layer = Layer.effect(GrantsStore, makeGrantsStore());
