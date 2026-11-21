import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AccountNotFound, Unauthorized } from "../errors.ts";
import type { Account, ApiToken, Caller } from "./schemas.ts";

/** Accounts, their API tokens, and whose a token is. */
export interface AccountsShape {
  readonly create: (account: {
    readonly name: string;
    readonly admin: boolean;
  }) => Effect.Effect<Account>;
  readonly list: () => Effect.Effect<ReadonlyArray<Account>>;
  /** A new API token of the account. The secret is told here and kept nowhere. */
  readonly createToken: (
    accountId: string,
    name: string,
  ) => Effect.Effect<{ readonly token: ApiToken; readonly secret: string }, AccountNotFound>;
  /** Whose a bearer token is. */
  readonly identify: (bearer: string) => Effect.Effect<Caller, Unauthorized>;
}

export class Accounts extends Context.Service<Accounts, AccountsShape>()(
  "@aperture-browser/control/Accounts",
) {}
