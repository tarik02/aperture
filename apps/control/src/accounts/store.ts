import type { Scope, TokenResources } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
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
  /** Whether any account is or ever was a person's, those that were deleted among them. */
  readonly anyPerson: () => Effect.Effect<boolean>;
  /**
   * Does what makes the first person, where no account is a person's, and tells what it
   * made; nothing where one is. Nothing else on this database does so meanwhile, so of
   * two that come together the second finds the person the first made.
   */
  readonly forFirstPerson: <A, E, R>(
    make: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly list: () => Effect.Effect<ReadonlyArray<Account>>;
  readonly find: (id: string) => Effect.Effect<Option.Option<Account>>;
  /** The account someone signs in as. */
  readonly findByPerson: (personId: string) => Effect.Effect<Option.Option<Account>>;
  /** The account of the person who signs in with that address, whatever its letters' case. */
  readonly findByEmail: (email: string) => Effect.Effect<Option.Option<Account>>;
  /** Says anew what an account is called and whether it is an admin's; what is left out stays. */
  readonly change: (
    id: string,
    said: { readonly name?: string | undefined; readonly admin?: boolean | undefined },
  ) => Effect.Effect<Option.Option<Account>>;
  /** Disables an account from then on, or with no moment puts it in use again. */
  readonly setDisabled: (id: string, at: Date | null) => Effect.Effect<Option.Option<Account>>;
  /**
   * Deletes an account with its API tokens, its grants, the share links it made and its
   * places in workspaces: none of them is found again, and all of them are kept. What it
   * made in workspaces stays theirs, with nobody said to have made it. Not one that has
   * sessions or snapshots of its own.
   */
  readonly delete: (id: string, at: Date) => Effect.Effect<void>;
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
      readonly expiresAt: DateTime.Utc | null;
    }>
  >;
}

export class AccountsStore extends Context.Service<AccountsStore, AccountsStoreShape>()(
  "@aperture-browser/control/AccountsStore",
) {}
