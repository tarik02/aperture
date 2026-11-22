import type { Scope, TokenResources } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Account, AccountKind, ApiToken } from "./schemas.ts";

export interface NewAccount {
  readonly id: string;
  readonly name: string;
  readonly admin: boolean;
  readonly kind: AccountKind;
  /** Who signs in as the account, for a person's: as what signs people in knows them. */
  readonly person: { readonly id: string; readonly email: string } | null;
  readonly createdAt: Date;
}

export interface NewApiToken {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly scopes: ReadonlyArray<Scope>;
  readonly resources: TokenResources | null;
}

/** Where accounts and their API tokens are kept. */
export interface AccountsStoreShape {
  readonly insert: (account: NewAccount) => Effect.Effect<Account>;
  /**
   * Keeps an account for a person who has none, and gives the one they have: the first
   * requests of someone new may come together.
   */
  readonly insertForPerson: (
    account: NewAccount & { readonly person: NonNullable<NewAccount["person"]> },
  ) => Effect.Effect<Account>;
  readonly list: () => Effect.Effect<ReadonlyArray<Account>>;
  readonly find: (id: string) => Effect.Effect<Option.Option<Account>>;
  /** The account someone signs in as. */
  readonly findByPerson: (personId: string) => Effect.Effect<Option.Option<Account>>;
  /** The account of the person who signs in with that address, whatever its letters' case. */
  readonly findByEmail: (email: string) => Effect.Effect<Option.Option<Account>>;
  /** Disables an account from then on, or with no moment puts it in use again. */
  readonly setDisabled: (id: string, at: Date | null) => Effect.Effect<Option.Option<Account>>;
  /**
   * Removes an account with its API tokens, its grants, the share links it made and its
   * places in workspaces. Not one that sessions or snapshots still name.
   */
  readonly delete: (id: string) => Effect.Effect<void>;
  readonly insertToken: (token: NewApiToken) => Effect.Effect<ApiToken>;
  /** An account's tokens, those taken back among them. */
  readonly listTokens: (accountId: string) => Effect.Effect<ReadonlyArray<ApiToken>>;
  readonly findToken: (id: string) => Effect.Effect<Option.Option<ApiToken>>;
  /** Takes a token back; one that was taken back before stays as it was. */
  readonly revokeToken: (id: string, now: Date) => Effect.Effect<void>;
  /** The account a token is of, by the token's digest, while the token is good. */
  readonly findByTokenHash: (
    tokenHash: string,
    now: Date,
  ) => Effect.Effect<
    Option.Option<{
      readonly account: Account;
      readonly scopes: ReadonlyArray<Scope>;
      readonly resources: TokenResources | null;
    }>
  >;
}

export class AccountsStore extends Context.Service<AccountsStore, AccountsStoreShape>()(
  "@aperture-browser/control/AccountsStore",
) {}
