import { type Caller, covers, type Scope } from "@aperture-browser/control-api";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Duration from "effect/Duration";
import {
  AccountInvalid,
  AccountNotFound,
  ApiTokenNotFound,
  PersonNotFound,
  Unauthorized,
} from "../errors.ts";
import { Identity } from "../identity/service.ts";
import * as Secrets from "../secrets.ts";
import { Settings } from "../settings/service.ts";
import { after, now } from "../time.ts";
import { accountOf, reaches } from "./caller.ts";
import type { Account, AccountKind } from "./schemas.ts";
import { Accounts } from "./service.ts";
import { AccountsStore } from "./store.ts";
import { WorkspacesStore } from "../workspaces/store.ts";

export const makeAccounts = Effect.fn("Accounts.make")(function* () {
  const store = yield* AccountsStore;
  const workspaces = yield* WorkspacesStore;
  const identity = yield* Identity;
  const settings = yield* Settings;
  const crypto = yield* Effect.context<Crypto.Crypto>();
  const bootstrap = yield* Secrets.hash(Redacted.value(settings.bootstrapToken));

  const create = Effect.fn("Accounts.create")(function* (account: {
    readonly name: string;
    readonly admin: boolean;
    readonly kind: AccountKind;
    readonly email: string | undefined;
  }) {
    if ((account.kind === "person") !== (account.email !== undefined)) {
      return yield* new AccountInvalid({
        message: "a person's account has an email address, and a service's has none",
      });
    }
    const person =
      account.email === undefined
        ? null
        : yield* identity.create({ email: account.email, name: account.name });
    return yield* store.insert({
      id: yield* Secrets.id,
      name: account.name,
      admin: account.admin,
      kind: account.kind,
      person,
      createdAt: yield* now,
    });
  }, Effect.provide(crypto));

  const setupToken = Effect.fn("Accounts.setupToken")(function* (accountId: string) {
    const account = yield* store.find(accountId);
    if (Option.isNone(account)) {
      return yield* new AccountNotFound({ id: accountId });
    }
    if (account.value.email === null) {
      return yield* new PersonNotFound({ email: "" });
    }
    return yield* identity.setupToken(account.value.email);
  });

  const resetSecondFactor = Effect.fn("Accounts.resetSecondFactor")(function* (accountId: string) {
    const account = yield* store.find(accountId);
    if (Option.isNone(account)) {
      return yield* new AccountNotFound({ id: accountId });
    }
    if (account.value.email === null) {
      return yield* new PersonNotFound({ email: "" });
    }
    yield* identity.resetSecondFactor(account.value.email);
  });

  /** The caller an account is, with the workspaces it is in. */
  const callerOf = Effect.fn(function* (
    account: Account,
    scopes: ReadonlyArray<Scope> | null = null,
  ) {
    const joined = yield* workspaces.of(account.id);
    return {
      account: Option.some(account),
      // An admin's token is an admin's only where it is not held to less.
      admin: account.admin && covers(scopes, "admin"),
      scopes,
      workspaces: joined.map(({ workspace, role }) => ({ id: workspace.id, role })),
    } satisfies Caller;
  });

  const ofPerson = Effect.fn("Accounts.ofPerson")(function* (headers: Headers) {
    const person = yield* identity.personOf(headers);
    const account = Option.isNone(person)
      ? Option.none<Account>()
      : yield* store.findByPerson(person.value.id);
    if (Option.isNone(account)) {
      return yield* new Unauthorized({ message: "nobody is signed in" });
    }
    return yield* callerOf(account.value);
  });

  const list = Effect.fn("Accounts.list")(function* () {
    return yield* store.list();
  });

  const createToken = Effect.fn("Accounts.createToken")(function* (
    accountId: string,
    name: string,
    lasts?: Duration.Duration,
    scopes?: ReadonlyArray<Scope>,
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
      scopes: scopes ?? null,
    });
    return { token, secret };
  }, Effect.provide(crypto));

  const identify = Effect.fn("Accounts.identify")(function* (bearer: string) {
    const hashed = yield* Secrets.hash(bearer);
    // Digests are compared, so how long it takes tells nothing of the token.
    if (hashed === bootstrap) {
      return { account: Option.none(), admin: true, scopes: null, workspaces: [] } satisfies Caller;
    }
    const held = yield* store.findByTokenHash(hashed, yield* now);
    if (Option.isNone(held)) {
      return yield* new Unauthorized({ message: "that is no token of an account" });
    }
    return yield* callerOf(held.value.account, held.value.scopes);
  }, Effect.provide(crypto));

  const tokens = Effect.fn("Accounts.tokens")(function* (caller: Caller) {
    const account = yield* accountOf(caller);
    return yield* store.listTokens(account.id);
  });

  const revokeToken = Effect.fn("Accounts.revokeToken")(function* (caller: Caller, id: string) {
    const token = Option.filter(yield* store.findToken(id), (found) =>
      reaches(caller, { accountId: found.accountId, workspaceId: null }),
    );
    if (Option.isNone(token)) {
      return yield* new ApiTokenNotFound({ id });
    }
    yield* store.revokeToken(id, yield* now);
  });

  return Accounts.of({
    create,
    setupToken,
    resetSecondFactor,
    ofPerson,
    list,
    createToken,
    tokens,
    revokeToken,
    identify,
  });
});

export const layer = Layer.effect(Accounts, makeAccounts());
