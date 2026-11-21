import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { all, first, one } from "../store/rows.ts";
import { Account, ApiToken } from "./schemas.ts";
import { AccountsStore, type NewAccount, type NewApiToken } from "./store.ts";

/** Accounts in the SQL database. */
export const makeAccountsStore = Effect.fn("AccountsStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insert = Effect.fn("AccountsStore.insert")(function* (account: NewAccount) {
    return yield* sql`
      INSERT INTO accounts (id, name, admin, created_at)
      VALUES (${account.id}, ${account.name}, ${account.admin}, ${account.createdAt})
      RETURNING *
    `.pipe(one(Account));
  });

  const list = Effect.fn("AccountsStore.list")(function* () {
    return yield* sql`SELECT * FROM accounts ORDER BY created_at, id`.pipe(all(Account));
  });

  const find = Effect.fn("AccountsStore.find")(function* (id: string) {
    return yield* sql`SELECT * FROM accounts WHERE id = ${id}`.pipe(first(Account));
  });

  const insertToken = Effect.fn("AccountsStore.insertToken")(function* (token: NewApiToken) {
    return yield* sql`
      INSERT INTO api_tokens (id, account_id, name, token_hash, created_at)
      VALUES (
        ${token.id}, ${token.accountId}, ${token.name}, ${token.tokenHash}, ${token.createdAt}
      )
      RETURNING id, account_id, name, created_at
    `.pipe(one(ApiToken));
  });

  const findByTokenHash = Effect.fn("AccountsStore.findByTokenHash")(function* (tokenHash: string) {
    return yield* sql`
      SELECT accounts.*
      FROM accounts
      JOIN api_tokens ON api_tokens.account_id = accounts.id
      WHERE api_tokens.token_hash = ${tokenHash}
    `.pipe(first(Account));
  });

  return AccountsStore.of({ insert, list, find, insertToken, findByTokenHash });
});

export const layer = Layer.effect(AccountsStore, makeAccountsStore());
