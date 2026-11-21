import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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

/**
 * Who a request to the control plane comes from: an account, or the holder of the
 * bootstrap token, who is an admin and no account.
 */
export interface Caller {
  readonly account: Option.Option<Account>;
  readonly admin: boolean;
}
