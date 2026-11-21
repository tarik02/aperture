import type { Caller } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";
import type { AccountNotFound, ApiTokenNotFound, Forbidden, Unauthorized } from "../errors.ts";
import type { Account, AccountKind, ApiToken } from "./schemas.ts";

/** Accounts, their API tokens, and whose a token is. */
export interface AccountsShape {
  readonly create: (account: {
    readonly name: string;
    readonly admin: boolean;
    readonly kind: AccountKind;
  }) => Effect.Effect<Account>;
  readonly list: () => Effect.Effect<ReadonlyArray<Account>>;
  /** A new API token of the account. The secret is told here and kept nowhere. */
  readonly createToken: (
    accountId: string,
    name: string,
    /** How long the token is good for; for as long as it is not taken back, without. */
    lasts?: Duration.Duration,
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
