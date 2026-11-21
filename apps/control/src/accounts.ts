import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { AccountNotFound, Unauthorized } from "./errors.ts";
import * as Secrets from "./secrets.ts";
import { Settings } from "./settings.ts";
import { type Account, AccountsStore, type ApiToken } from "./store/accounts.ts";
import { now } from "./time.ts";

/**
 * Who a request to the control plane comes from: an account, or the holder of the
 * bootstrap token, who is an admin and no account.
 */
export interface Caller {
  readonly account: Option.Option<Account>;
  readonly admin: boolean;
}

export class Accounts extends Context.Service<
  Accounts,
  {
    readonly create: (account: {
      readonly name: string;
      readonly admin: boolean;
    }) => Effect.Effect<Account>;
    readonly list: Effect.Effect<ReadonlyArray<Account>>;
    /** A new API token of the account. The secret is told here and kept nowhere. */
    readonly createToken: (
      accountId: string,
      name: string,
    ) => Effect.Effect<{ readonly token: ApiToken; readonly secret: string }, AccountNotFound>;
    /** Whose a bearer token is. */
    readonly identify: (bearer: string) => Effect.Effect<Caller, Unauthorized>;
  }
>()("@aperture-browser/control/Accounts") {
  static readonly layer = Layer.effect(
    Accounts,
    Effect.gen(function* () {
      const store = yield* AccountsStore;
      const settings = yield* Settings;
      const crypto = yield* Effect.context<Crypto.Crypto>();
      const bootstrap = yield* Secrets.hash(Redacted.value(settings.bootstrapToken));

      return Accounts.of({
        create: Effect.fn("Accounts.create")(function* (account) {
          return yield* store.insert({
            id: yield* Secrets.id,
            name: account.name,
            admin: account.admin,
            createdAt: yield* now,
          });
        }, Effect.provide(crypto)),
        list: store.list,
        createToken: Effect.fn("Accounts.createToken")(function* (accountId, name) {
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
          });
          return { token, secret };
        }, Effect.provide(crypto)),
        identify: Effect.fn("Accounts.identify")(function* (bearer) {
          const hashed = yield* Secrets.hash(bearer);
          // Digests are compared, so how long it takes tells nothing of the token.
          if (hashed === bootstrap) {
            return { account: Option.none(), admin: true };
          }
          const account = yield* store.findByTokenHash(hashed);
          if (Option.isNone(account)) {
            return yield* new Unauthorized({ message: "that is no token of an account" });
          }
          return { account, admin: account.value.admin };
        }, Effect.provide(crypto)),
      });
    }),
  );
}
