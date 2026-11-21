import type { Caller, Scope, TokenResources } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";
import type {
  AccountInUse,
  AccountInvalid,
  AccountNotFound,
  ApiTokenNotFound,
  EmailTaken,
  Forbidden,
  PersonNotFound,
  Unauthorized,
} from "../errors.ts";
import type { SignInMethods } from "../identity/service.ts";
import type { Account, AccountKind, ApiToken } from "./schemas.ts";

/** Accounts, their API tokens, and whose a token is. */
export interface AccountsShape {
  readonly create: (account: {
    readonly name: string;
    readonly admin: boolean;
    readonly kind: AccountKind;
    /** The address a person signs in with; a person's account has one, and a service's none. */
    readonly email: string | undefined;
  }) => Effect.Effect<Account, EmailTaken | AccountInvalid>;
  /** A token with which the person of an account sets a password: a first one, or another. */
  readonly setupToken: (
    accountId: string,
  ) => Effect.Effect<string, AccountNotFound | PersonNotFound>;
  /** Turns the second factor of an account's person off, for one who lost what gives its codes. */
  readonly resetSecondFactor: (
    accountId: string,
  ) => Effect.Effect<void, AccountNotFound | PersonNotFound>;
  /** Removes the passkeys of an account's person, for one who lost what holds them. */
  readonly removePasskeys: (
    accountId: string,
  ) => Effect.Effect<void, AccountNotFound | PersonNotFound>;
  /** Who a browser's cookies sign in. */
  readonly ofPerson: (headers: Headers) => Effect.Effect<Caller, Unauthorized>;
  /** Every account, each person's with what they sign in with. */
  readonly list: () => Effect.Effect<
    ReadonlyArray<Account & { readonly signIn: SignInMethods | null }>
  >;
  /**
   * Disables an account: nothing signs in as it, and its cookies, API tokens and the
   * tokens of its grants are nobody's from then on, while all that is its own stays.
   * Whoever is in a session as it is put out, and so are the guests of the share links
   * it made, which let nobody in until it is in use again. Nobody disables their own
   * account, and the last admin stays.
   */
  readonly disable: (
    caller: Caller,
    id: string,
  ) => Effect.Effect<Account, AccountNotFound | Forbidden | AccountInUse>;
  /** Puts a disabled account in use again, with all it had. */
  readonly enable: (id: string) => Effect.Effect<Account, AccountNotFound>;
  /**
   * Removes an account with its person, its API tokens, its grants, the share links it
   * made, whose guests are put out, and its places in workspaces. Not while a session or
   * a snapshot names it: those are removed first. Nobody removes their own account, and the last admin stays.
   */
  readonly remove: (
    caller: Caller,
    id: string,
  ) => Effect.Effect<void, AccountNotFound | Forbidden | AccountInUse>;
  /** A new API token of the account. The secret is told here and kept nowhere. */
  readonly createToken: (
    accountId: string,
    name: string,
    /** How long the token is good for; for as long as it is not taken back, without. */
    lasts?: Duration.Duration,
    /** What the token is held to; whatever its account does, without. */
    scopes?: ReadonlyArray<Scope>,
    /** The resources the token is held to; all that its account reaches, without. */
    resources?: TokenResources,
  ) => Effect.Effect<{ readonly token: ApiToken; readonly secret: string }, AccountNotFound>;
  /** The tokens of the caller's own account, those taken back among them. */
  readonly tokens: (caller: Caller) => Effect.Effect<ReadonlyArray<ApiToken>, Forbidden>;
  /** Takes a token back: one of the caller's own account, or any for an admin. */
  readonly revokeToken: (caller: Caller, id: string) => Effect.Effect<void, ApiTokenNotFound>;
  /** Whose a bearer token is. */
  readonly identify: (bearer: string) => Effect.Effect<Caller, Unauthorized>;
}

export class Accounts extends Context.Service<Accounts, AccountsShape>()(
  "@aperture-browser/control/Accounts",
) {}
