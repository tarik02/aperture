import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Account, ApiToken } from "./schemas.ts";

export interface NewAccount {
  readonly id: string;
  readonly name: string;
  readonly admin: boolean;
  readonly createdAt: Date;
}

export interface NewApiToken {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
}

/** Where accounts and their API tokens are kept. */
export interface AccountsStoreShape {
  readonly insert: (account: NewAccount) => Effect.Effect<Account>;
  readonly list: () => Effect.Effect<ReadonlyArray<Account>>;
  readonly find: (id: string) => Effect.Effect<Option.Option<Account>>;
  readonly insertToken: (token: NewApiToken) => Effect.Effect<ApiToken>;
  /** The account a token is of, by the token's digest. */
  readonly findByTokenHash: (tokenHash: string) => Effect.Effect<Option.Option<Account>>;
}

export class AccountsStore extends Context.Service<AccountsStore, AccountsStoreShape>()(
  "@aperture-browser/control/AccountsStore",
) {}
