import * as Effect from "effect/Effect";
import { Scope, TokenResources } from "@aperture-browser/control-api";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "../store/rows.ts";
import { Account, ApiToken } from "./schemas.ts";
import { AccountsStore, type NewAccount, type NewApiToken } from "./store.ts";

const Held = Schema.Struct({
  ...Account.fields,
  scopes: Schema.NullOr(Schema.Array(Scope)),
  resources: Schema.NullOr(TokenResources),
});

/** Accounts in the SQL database. */
export const makeAccountsStore = Effect.fn("AccountsStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Never the digest: a token is known by it, and it is told to nobody.
  const token = sql.literal(
    "id, account_id, name, created_at, expires_at, revoked_at, scopes, resources",
  );

  const insert = Effect.fn("AccountsStore.insert")(function* (account: NewAccount) {
    return yield* sql`
      INSERT INTO accounts (id, name, admin, kind, person_id, email, created_at)
      VALUES (
        ${account.id}, ${account.name}, ${account.admin}, ${account.kind},
        ${account.person?.id ?? null}, ${account.person?.email ?? null}, ${account.createdAt}
      )
      RETURNING *
    `.pipe(one(Account));
  });

  const list = Effect.fn("AccountsStore.list")(function* () {
    return yield* sql`SELECT * FROM accounts ORDER BY created_at, id`.pipe(all(Account));
  });

  const find = Effect.fn("AccountsStore.find")(function* (id: string) {
    return yield* sql`SELECT * FROM accounts WHERE id = ${id}`.pipe(first(Account));
  });

  const findByPerson = Effect.fn("AccountsStore.findByPerson")(function* (personId: string) {
    return yield* sql`SELECT * FROM accounts WHERE person_id = ${personId}`.pipe(first(Account));
  });

  const insertForPerson = Effect.fn("AccountsStore.insertForPerson")(function* (
    account: NewAccount & { readonly person: NonNullable<NewAccount["person"]> },
  ) {
    yield* sql`
      INSERT INTO accounts (id, name, admin, kind, person_id, email, created_at)
      VALUES (
        ${account.id}, ${account.name}, ${account.admin}, ${account.kind},
        ${account.person.id}, ${account.person.email}, ${account.createdAt}
      )
      ON CONFLICT (person_id) DO NOTHING
    `.pipe(done);
    return yield* sql`SELECT * FROM accounts WHERE person_id = ${account.person.id}`.pipe(
      one(Account),
    );
  });

  const insertToken = Effect.fn("AccountsStore.insertToken")(function* (given: NewApiToken) {
    return yield* sql`
      INSERT INTO api_tokens (
        id, account_id, name, token_hash, created_at, expires_at, scopes, resources
      )
      VALUES (
        ${given.id}, ${given.accountId}, ${given.name}, ${given.tokenHash}, ${given.createdAt},
        ${given.expiresAt}, ${given.scopes === null ? null : JSON.stringify(given.scopes)}::jsonb,
        ${given.resources === null ? null : JSON.stringify(given.resources)}::jsonb
      )
      RETURNING ${token}
    `.pipe(one(ApiToken));
  });

  const listTokens = Effect.fn("AccountsStore.listTokens")(function* (accountId: string) {
    return yield* sql`
      SELECT ${token} FROM api_tokens WHERE account_id = ${accountId} ORDER BY created_at, id
    `.pipe(all(ApiToken));
  });

  const findToken = Effect.fn("AccountsStore.findToken")(function* (id: string) {
    return yield* sql`SELECT ${token} FROM api_tokens WHERE id = ${id}`.pipe(first(ApiToken));
  });

  const revokeToken = Effect.fn("AccountsStore.revokeToken")(function* (id: string, now: Date) {
    yield* sql`
      UPDATE api_tokens SET revoked_at = ${now} WHERE id = ${id} AND revoked_at IS NULL
    `.pipe(done);
  });

  const findByTokenHash = Effect.fn("AccountsStore.findByTokenHash")(function* (
    tokenHash: string,
    now: Date,
  ) {
    const found = yield* sql`
      SELECT accounts.*, api_tokens.scopes, api_tokens.resources
      FROM accounts
      JOIN api_tokens ON api_tokens.account_id = accounts.id
      WHERE api_tokens.token_hash = ${tokenHash}
        AND api_tokens.revoked_at IS NULL
        AND (api_tokens.expires_at IS NULL OR api_tokens.expires_at > ${now})
    `.pipe(first(Held));
    return Option.map(found, ({ scopes, resources, ...account }) => ({
      account,
      scopes,
      resources,
    }));
  });

  return AccountsStore.of({
    insert,
    insertForPerson,
    list,
    find,
    findByPerson,
    insertToken,
    listTokens,
    findToken,
    revokeToken,
    findByTokenHash,
  });
});

export const layer = Layer.effect(AccountsStore, makeAccountsStore());
