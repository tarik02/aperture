import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Forbidden } from "../errors.ts";
import type { Account, Caller } from "./schemas.ts";

/** The caller's account, for what is an account's alone to have: sessions, snapshots. */
export const accountOf = (caller: Caller): Effect.Effect<Account, Forbidden> =>
  Option.match(caller.account, {
    onNone: () =>
      Effect.fail(
        new Forbidden({ message: "this is an account's to do, and this token is of none" }),
      ),
    onSome: Effect.succeed,
  });

/** Whether what is that account's is the caller's to see and change: their own, or anyone's for an admin. */
export const reaches = (caller: Caller, accountId: string) =>
  caller.admin || Option.exists(caller.account, (account) => account.id === accountId);
