import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, first, one } from "./rows.ts";

export const Account = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  admin: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromDate,
});
export type Account = typeof Account.Type;

/** An API token as it is kept: what it is called and whose it is, and never the token. */
export const ApiToken = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromDate,
});
export type ApiToken = typeof ApiToken.Type;

export class AccountsStore extends Context.Service<
  AccountsStore,
  {
    readonly insert: (account: {
      readonly id: string;
      readonly name: string;
      readonly admin: boolean;
      readonly createdAt: Date;
    }) => Effect.Effect<Account>;
    readonly list: Effect.Effect<ReadonlyArray<Account>>;
    readonly find: (id: string) => Effect.Effect<Option.Option<Account>>;
    readonly insertToken: (token: {
      readonly id: string;
      readonly accountId: string;
      readonly name: string;
      readonly tokenHash: string;
      readonly createdAt: Date;
    }) => Effect.Effect<ApiToken>;
    /** The account a token is of, by the token's digest. */
    readonly findByTokenHash: (tokenHash: string) => Effect.Effect<Option.Option<Account>>;
  }
>()("@aperture-browser/control/AccountsStore") {
  static readonly layer = Layer.effect(
    AccountsStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return AccountsStore.of({
        insert: (account) =>
          sql`
            INSERT INTO accounts (id, name, admin, created_at)
            VALUES (${account.id}, ${account.name}, ${account.admin}, ${account.createdAt})
            RETURNING *
          `.pipe(one(Account)),
        list: sql`SELECT * FROM accounts ORDER BY created_at, id`.pipe(all(Account)),
        find: (id) => sql`SELECT * FROM accounts WHERE id = ${id}`.pipe(first(Account)),
        insertToken: (token) =>
          sql`
            INSERT INTO api_tokens (id, account_id, name, token_hash, created_at)
            VALUES (
              ${token.id}, ${token.accountId}, ${token.name}, ${token.tokenHash},
              ${token.createdAt}
            )
            RETURNING id, account_id, name, created_at
          `.pipe(one(ApiToken)),
        findByTokenHash: (tokenHash) =>
          sql`
            SELECT accounts.*
            FROM accounts
            JOIN api_tokens ON api_tokens.account_id = accounts.id
            WHERE api_tokens.token_hash = ${tokenHash}
          `.pipe(first(Account)),
      });
    }),
  );
}
