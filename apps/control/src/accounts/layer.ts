import type { Caller } from "@aperture-browser/control-api";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Duration from "effect/Duration";
import { AccountNotFound, ApiTokenNotFound, Unauthorized } from "../errors.ts";
import * as Secrets from "../secrets.ts";
import { Settings } from "../settings/service.ts";
import { after, now } from "../time.ts";
import { accountOf, reaches } from "./caller.ts";
import { Accounts } from "./service.ts";
import { AccountsStore } from "./store.ts";

export const makeAccounts = Effect.fn("Accounts.make")(function* () {
  const store = yield* AccountsStore;
  const settings = yield* Settings;
  const crypto = yield* Effect.context<Crypto.Crypto>();
  const bootstrap = yield* Secrets.hash(Redacted.value(settings.bootstrapToken));

  const create = Effect.fn("Accounts.create")(function* (account: {
    readonly name: string;
    readonly admin: boolean;
  }) {
    return yield* store.insert({
      id: yield* Secrets.id,
      name: account.name,
      admin: account.admin,
      createdAt: yield* now,
    });
  }, Effect.provide(crypto));

  const list = Effect.fn("Accounts.list")(function* () {
    return yield* store.list();
  });

  const createToken = Effect.fn("Accounts.createToken")(function* (
    accountId: string,
    name: string,
    lasts?: Duration.Duration,
  ) {
    const account = yield* store.find(accountId);
    if (Option.isNone(account)) {
      return yield* new AccountNotFound({ id: accountId });
    }
    const secret = yield* Secrets.make("apc");
    const token = yield* store.insertToken({
      id: yield* Secrets.id,
      accountId,
      name,
      tokenHash: yield* Secrets.hash(secret),
      createdAt: yield* now,
      expiresAt: lasts === undefined ? null : yield* after(lasts),
    });
    return { token, secret };
  }, Effect.provide(crypto));

  const identify = Effect.fn("Accounts.identify")(function* (bearer: string) {
    const hashed = yield* Secrets.hash(bearer);
    // Digests are compared, so how long it takes tells nothing of the token.
    if (hashed === bootstrap) {
      return { account: Option.none(), admin: true } satisfies Caller;
    }
    const account = yield* store.findByTokenHash(hashed, yield* now);
    if (Option.isNone(account)) {
      return yield* new Unauthorized({ message: "that is no token of an account" });
    }
    return { account, admin: account.value.admin } satisfies Caller;
  }, Effect.provide(crypto));

  const tokens = Effect.fn("Accounts.tokens")(function* (caller: Caller) {
    const account = yield* accountOf(caller);
    return yield* store.listTokens(account.id);
  });

  const revokeToken = Effect.fn("Accounts.revokeToken")(function* (caller: Caller, id: string) {
    const token = Option.filter(yield* store.findToken(id), (found) =>
      reaches(caller, found.accountId),
    );
    if (Option.isNone(token)) {
      return yield* new ApiTokenNotFound({ id });
    }
    yield* store.revokeToken(id, yield* now);
  });

  return Accounts.of({ create, list, createToken, tokens, revokeToken, identify });
});

export const layer = Layer.effect(Accounts, makeAccounts());
