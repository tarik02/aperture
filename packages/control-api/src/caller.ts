import type * as DateTime from "effect/DateTime";
import type * as Option from "effect/Option";

/**
 * Who a request to the control plane comes from: an account, or the holder of the
 * bootstrap token, who is an admin and no account.
 */
export interface Caller {
  readonly account: Option.Option<{
    readonly id: string;
    readonly name: string;
    readonly admin: boolean;
    readonly createdAt: DateTime.Utc;
  }>;
  readonly admin: boolean;
}
