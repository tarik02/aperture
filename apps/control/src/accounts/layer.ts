import {
  type Caller,
  covers,
  type Scope,
  type TokenResources,
} from "@aperture-browser/control-api";
import * as UrlPath from "@aperture-browser/shared/url-path";
import type * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  AccountInUse,
  AccountInvalid,
  AccountNotFound,
  ApiTokenNotFound,
  Forbidden,
  PersonNotFound,
  Unauthorized,
} from "../errors.ts";
import { GrantsStore } from "../grants/store.ts";
import { Identity } from "../identity/service.ts";
import { Nodes } from "../nodes/service.ts";
import { SessionsStore } from "../sessions/store.ts";
import { SnapshotsStore } from "../snapshots/store.ts";
import * as Secrets from "../secrets.ts";
import { Settings } from "../settings/service.ts";
import { after, now } from "../time.ts";
import { accountOf, reaches } from "./caller.ts";
import type { Account, AccountKind } from "./schemas.ts";
import { Accounts } from "./service.ts";
import { AccountsStore } from "./store.ts";
import { WorkspacesStore } from "../workspaces/store.ts";

/** How long a node gets to put someone out of a session before it is left to their ticket running out. */
const DISMISSED_WITHIN = Duration.seconds(5);
/** How many sessions' nodes are asked at a time to put someone out. */
const DISMISSED_AT_ONCE = 16;

const counted = (count: number, what: string) => `${count} ${what}${count === 1 ? "" : "s"}`;

export const makeAccounts = Effect.fn("Accounts.make")(function* () {
  const store = yield* AccountsStore;
  const sessions = yield* SessionsStore;
  const snapshots = yield* SnapshotsStore;
  const nodes = yield* Nodes;
  const client = yield* HttpClient.HttpClient;
  const grants = yield* GrantsStore;
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

  const removePasskeys = Effect.fn("Accounts.removePasskeys")(function* (accountId: string) {
    const account = yield* store.find(accountId);
    if (Option.isNone(account)) {
      return yield* new AccountNotFound({ id: accountId });
    }
    if (account.value.email === null) {
      return yield* new PersonNotFound({ email: "" });
    }
    yield* identity.removePasskeys(account.value.email);
  });

  /** The caller an account is, with the workspaces it is in. */
  const callerOf = Effect.fn(function* (
    account: Account,
    scopes: ReadonlyArray<Scope> | null = null,
    resources: TokenResources | null = null,
  ) {
    const joined = yield* workspaces.of(account.id);
    return {
      account: Option.some(account),
      // An admin's token is an admin's only where it is not held to less.
      admin: account.admin && covers(scopes, "admin"),
      scopes,
      resources,
      workspaces: joined.map(({ workspace, role }) => ({ id: workspace.id, role })),
    } satisfies Caller;
  });

  /** The caller an account is, unless it is disabled: then it is nobody. */
  const inUse = Effect.fn(function* (
    account: Account,
    scopes: ReadonlyArray<Scope> | null = null,
    resources: TokenResources | null = null,
  ) {
    if (account.disabledAt !== null) {
      return yield* new Unauthorized({ message: "this account is disabled" });
    }
    return yield* callerOf(account, scopes, resources);
  });

  const ofPerson = Effect.fn("Accounts.ofPerson")(function* (headers: Headers) {
    const person = yield* identity.personOf(headers);
    if (Option.isNone(person)) {
      return yield* new Unauthorized({ message: "nobody is signed in" });
    }
    const account = yield* store.findByPerson(person.value.id);
    if (Option.isSome(account)) {
      return yield* inUse(account.value);
    }
    // Someone no admin made a person is one a provider vouched for, where that makes
    // people: their account is made when they first come.
    if (!settings.provisionPeople) {
      return yield* new Unauthorized({ message: "nobody is signed in" });
    }
    return yield* callerOf(
      yield* store.insertForPerson({
        id: yield* Secrets.id,
        name: person.value.name.trim() || person.value.email,
        admin: false,
        kind: "person",
        person: { id: person.value.id, email: person.value.email },
        createdAt: yield* now,
      }),
    );
  }, Effect.provide(crypto));

  const list = Effect.fn("Accounts.list")(function* () {
    const all = yield* store.list();
    const methods = yield* identity.methods();
    return all.map((account) => ({
      ...account,
      signIn: account.email === null ? null : (methods.get(account.email) ?? null),
    }));
  });

  /** The account that is to be disabled or removed, where the caller may and it may be. */
  const dispensable = Effect.fn(function* (caller: Caller, id: string) {
    const account = yield* store.find(id);
    if (Option.isNone(account)) {
      return yield* new AccountNotFound({ id });
    }
    if (Option.exists(caller.account, (own) => own.id === id)) {
      return yield* new Forbidden({ message: "nobody disables or removes their own account" });
    }
    const others = (yield* store.list()).filter(
      (other) => other.admin && other.disabledAt === null && other.id !== id,
    );
    if (account.value.admin && account.value.disabledAt === null && others.length === 0) {
      return yield* new AccountInUse({ id, message: "this is the last admin there is" });
    }
    return account.value;
  });

  /**
   * Has the nodes close the sockets someone has open into sessions as the account: what
   * was opened with a ticket stays open after the ticket otherwise.
   */
  const dismiss = Effect.fn(function* (id: string) {
    const running = (yield* sessions.list()).filter((session) => session.nodeId !== null);
    yield* Effect.forEach(
      running,
      Effect.fn(function* (session) {
        const node = session.nodeId === null ? Option.none() : yield* nodes.find(session.nodeId);
        if (Option.isNone(node)) {
          return;
        }
        const url = UrlPath.make`${UrlPath.raw(node.value.internalUrl)}/sessions/${session.id}/callers/${id}`;
        yield* client
          .execute(
            HttpClientRequest.delete(url).pipe(
              HttpClientRequest.bearerToken(node.value.operatorToken),
            ),
          )
          .pipe(
            Effect.timeout(DISMISSED_WITHIN),
            // The account is nobody's way in either way: who is still in is out when
            // the socket next ends.
            Effect.catch((error) =>
              Effect.logWarning(
                `node ${node.value.name} did not put an account out of a session: ${error.message}`,
              ),
            ),
          );
      }),
      { concurrency: DISMISSED_AT_ONCE, discard: true },
    );
  });

  const disable = Effect.fn("Accounts.disable")(function* (caller: Caller, id: string) {
    const account = yield* dispensable(caller, id);
    const disabled = Option.getOrElse(yield* store.setDisabled(id, yield* now), () => account);
    if (account.email !== null) {
      // Someone a provider vouched for may not have come since their account was made.
      yield* identity.signOut(account.email).pipe(Effect.ignore);
    }
    yield* dismiss(id);
    return disabled;
  });

  const enable = Effect.fn("Accounts.enable")(function* (id: string) {
    const enabled = yield* store.setDisabled(id, null);
    if (Option.isNone(enabled)) {
      return yield* new AccountNotFound({ id });
    }
    return enabled.value;
  });

  const remove = Effect.fn("Accounts.remove")(function* (caller: Caller, id: string) {
    const account = yield* dispensable(caller, id);
    // Whatever names the account, a workspace's as well: it says who made it.
    const itsSessions = (yield* sessions.list()).filter((session) => session.accountId === id);
    const itsSnapshots = (yield* snapshots.list()).filter((snapshot) => snapshot.accountId === id);
    if (itsSessions.length + itsSnapshots.length > 0) {
      return yield* new AccountInUse({
        id,
        message: `it still has ${counted(itsSessions.length, "session")} and ${counted(itsSnapshots.length, "snapshot")}: remove them first, or disable the account`,
      });
    }
    if (account.email !== null) {
      // Gone already where removing was tried before and did not end.
      yield* identity.remove(account.email).pipe(Effect.ignore);
    }
    yield* dismiss(id);
    yield* store.delete(id);
  });

  const createToken = Effect.fn("Accounts.createToken")(function* (
    accountId: string,
    name: string,
    lasts?: Duration.Duration,
    scopes?: ReadonlyArray<Scope>,
    resources?: TokenResources,
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
      resources: resources ?? null,
    });
    return { token, secret };
  }, Effect.provide(crypto));

  const identify = Effect.fn("Accounts.identify")(function* (bearer: string) {
    const hashed = yield* Secrets.hash(bearer);
    // Digests are compared, so how long it takes tells nothing of the token.
    if (hashed === bootstrap) {
      return {
        account: Option.none(),
        admin: true,
        scopes: null,
        resources: null,
        workspaces: [],
      } satisfies Caller;
    }
    const held = yield* store.findByTokenHash(hashed, yield* now);
    if (Option.isSome(held)) {
      return yield* inUse(held.value.account, held.value.scopes, held.value.resources);
    }
    // A token an app has of a grant is its account's as an API token is, held to what
    // the grant says.
    const granted = yield* grants.findByAccessToken(hashed, yield* now);
    const account = Option.isNone(granted)
      ? Option.none<Account>()
      : yield* store.find(granted.value.accountId);
    if (Option.isNone(granted) || Option.isNone(account)) {
      return yield* new Unauthorized({ message: "that is no token of an account" });
    }
    return yield* inUse(account.value, granted.value.scopes, granted.value.resources);
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
    removePasskeys,
    ofPerson,
    list,
    disable,
    enable,
    remove,
    createToken,
    tokens,
    revokeToken,
    identify,
  });
});

export const layer = Layer.effect(Accounts, makeAccounts());
