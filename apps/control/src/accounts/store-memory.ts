import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Memory, moment, ordered } from "../store/memory.ts";
import type { Account, ApiToken } from "./schemas.ts";
import { AccountsStore, type NewAccount, type NewApiToken } from "./store.ts";

/** Accounts kept in memory. */
export const makeAccountsStoreMemory = Effect.fn("AccountsStore.makeMemory")(function* () {
  const memory = yield* Memory;

  const insert = Effect.fn("AccountsStore.insert")((account: NewAccount) =>
    Effect.sync(() => {
      const kept: Account = {
        id: account.id,
        name: account.name,
        admin: account.admin,
        createdAt: moment(account.createdAt),
      };
      memory.accounts.set(kept.id, kept);
      return kept;
    }),
  );

  const list = Effect.fn("AccountsStore.list")(() =>
    Effect.sync(() => ordered(memory.accounts.values(), (account) => account.createdAt)),
  );

  const find = Effect.fn("AccountsStore.find")((id: string) =>
    Effect.sync(() => Option.fromUndefinedOr(memory.accounts.get(id))),
  );

  const insertToken = Effect.fn("AccountsStore.insertToken")((token: NewApiToken) =>
    Effect.sync(() => {
      const kept: ApiToken = {
        id: token.id,
        accountId: token.accountId,
        name: token.name,
        createdAt: moment(token.createdAt),
      };
      memory.apiTokens.set(token.tokenHash, kept);
      return kept;
    }),
  );

  const findByTokenHash = Effect.fn("AccountsStore.findByTokenHash")((tokenHash: string) =>
    Effect.sync(() =>
      Option.fromUndefinedOr(memory.apiTokens.get(tokenHash)).pipe(
        Option.flatMap((token) => Option.fromUndefinedOr(memory.accounts.get(token.accountId))),
      ),
    ),
  );

  return AccountsStore.of({ insert, list, find, insertToken, findByTokenHash });
});

export const layerTest = Layer.effect(AccountsStore, makeAccountsStoreMemory());
