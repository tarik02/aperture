import {
  type Caller,
  covers,
  type Scope,
  type TokenResources,
} from "@aperture-browser/control-api";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { accountOf, reaches } from "../accounts/caller.ts";
import {
  ClientInvalid,
  Forbidden,
  GrantNotFound,
  GrantRefused,
  OAuthClientNotFound,
  RedirectRefused,
} from "../errors.ts";
import * as Secrets from "../secrets.ts";
import { after, ago, now } from "../time.ts";
import type { Grant, Tokens } from "./schemas.ts";
import { type Asked, Grants } from "./service.ts";
import { GrantsStore } from "./store.ts";

const CODE_LASTS = Duration.minutes(5);
const ACCESS_LASTS = Duration.hours(1);
/** How long an app may stay away before the person is asked again. */
const REFRESH_LASTS = Duration.days(60);
/**
 * How long an app that registered is kept before anyone gave it a grant: a person decides
 * within the sitting they were asked in, and an app that is forgotten registers again.
 */
const UNGRANTED_LASTS = Duration.days(1);
const MAX_REDIRECTS = 16;
const MAX_LENGTH = 2048;
const UNNAMED = "An MCP client";
const LOOPBACK: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Schemes a browser runs or reads in place of going anywhere. */
const NO_ADDRESS: ReadonlySet<string> = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
]);

/**
 * Whether an app may be answered at an address: over TLS, on the machine it runs on, or
 * at a scheme of its own, as an app that is no page has one.
 */
const answerable = (given: string) => {
  if (given.length > MAX_LENGTH || !URL.canParse(given) || given.includes("#")) {
    return false;
  }
  const url = new URL(given);
  if (url.protocol === "http:") {
    return LOOPBACK.has(url.hostname);
  }
  return !NO_ADDRESS.has(url.protocol);
};

export const makeGrants = Effect.fn("Grants.make")(function* () {
  const store = yield* GrantsStore;
  const crypto = yield* Effect.context<Crypto.Crypto>();

  const register = Effect.fn("Grants.register")(function* (app: {
    readonly name: string | undefined;
    readonly redirectUris: ReadonlyArray<string>;
  }) {
    if (app.redirectUris.length === 0 || app.redirectUris.length > MAX_REDIRECTS) {
      return yield* new ClientInvalid({
        message: `an app names from one to ${MAX_REDIRECTS} addresses it is answered at`,
      });
    }
    const refused = app.redirectUris.find((uri) => !answerable(uri));
    if (refused !== undefined) {
      return yield* new ClientInvalid({
        message: `an app is not answered at ${refused.slice(0, MAX_LENGTH)}`,
      });
    }
    return yield* store.insertClient({
      id: yield* Secrets.id,
      name: app.name?.trim().slice(0, MAX_LENGTH) || UNNAMED,
      redirectUris: app.redirectUris,
      createdAt: yield* now,
    });
  }, Effect.provide(crypto));

  const asking = Effect.fn("Grants.asking")(function* (asked: Asked) {
    const client = yield* store.findClient(asked.clientId);
    if (Option.isNone(client)) {
      return yield* new OAuthClientNotFound({ id: asked.clientId });
    }
    // The address is the one it registered, to the letter: nothing is sent anywhere else.
    if (!client.value.redirectUris.includes(asked.redirectUri)) {
      return yield* new RedirectRefused({
        message: "the app did not register the address it asks to be answered at",
      });
    }
    return client.value;
  });

  const approve = Effect.fn("Grants.approve")(function* (
    caller: Caller,
    asked: Asked & {
      readonly codeChallenge: string;
      readonly scopes: ReadonlyArray<Scope>;
      readonly resources: TokenResources | undefined;
    },
  ) {
    const account = yield* accountOf(caller);
    if (caller.resources !== null) {
      return yield* new Forbidden({ message: "a token held to resources gives no grants" });
    }
    const beyond = asked.scopes.find((scope) => !covers(caller.scopes, scope));
    if (beyond !== undefined) {
      return yield* new Forbidden({ message: `this token is not for ${beyond} itself` });
    }
    const client = yield* asking(asked);
    const grantId = yield* Secrets.id;
    yield* store.insertGrant({
      id: grantId,
      accountId: account.id,
      clientId: client.id,
      scopes: asked.scopes,
      resources: asked.resources ?? null,
      createdAt: yield* now,
    });
    const code = yield* Secrets.make("apoc");
    yield* store.insertCode({
      codeHash: yield* Secrets.hash(code),
      grantId,
      redirectUri: asked.redirectUri,
      codeChallenge: asked.codeChallenge,
      expiresAt: yield* after(CODE_LASTS),
    });
    return code;
  }, Effect.provide(crypto));

  const issue = Effect.fn(function* (grant: Grant) {
    const accessToken = yield* Secrets.make("apo");
    const refreshToken = yield* Secrets.make("apor");
    yield* store.insertToken({
      tokenHash: yield* Secrets.hash(accessToken),
      grantId: grant.id,
      kind: "access",
      expiresAt: yield* after(ACCESS_LASTS),
    });
    yield* store.insertToken({
      tokenHash: yield* Secrets.hash(refreshToken),
      grantId: grant.id,
      kind: "refresh",
      expiresAt: yield* after(REFRESH_LASTS),
    });
    return {
      accessToken,
      refreshToken,
      expiresIn: Duration.toSeconds(ACCESS_LASTS),
      scopes: grant.scopes,
    } satisfies Tokens;
  });

  const exchange = Effect.fn("Grants.exchange")(function* (
    asked: Asked & { readonly code: string; readonly codeVerifier: string },
  ) {
    const code = yield* store.takeCode(yield* Secrets.hash(asked.code), yield* now);
    if (Option.isNone(code)) {
      return yield* new GrantRefused({ message: "the code is none that is good" });
    }
    const random = yield* Crypto.Crypto;
    const proven = Base64Url.encode(
      yield* Effect.orDie(random.digest("SHA-256", new TextEncoder().encode(asked.codeVerifier))),
    );
    const grant = yield* store.findGrant(code.value.grantId);
    if (
      Option.isNone(grant) ||
      code.value.clientId !== asked.clientId ||
      code.value.redirectUri !== asked.redirectUri ||
      code.value.codeChallenge !== proven
    ) {
      // A code that someone else tried was seen by someone else: what it was for is undone.
      yield* store.deleteGrant(code.value.grantId);
      return yield* new GrantRefused({ message: "the code was made for another request" });
    }
    return yield* issue(grant.value);
  }, Effect.provide(crypto));

  const refresh = Effect.fn("Grants.refresh")(function* (asked: {
    readonly clientId: string;
    readonly refreshToken: string;
  }) {
    const grant = yield* store.takeRefreshToken(
      yield* Secrets.hash(asked.refreshToken),
      yield* now,
    );
    if (Option.isNone(grant) || grant.value.clientId !== asked.clientId) {
      return yield* new GrantRefused({ message: "the refresh token is none that is good" });
    }
    return yield* issue(grant.value);
  }, Effect.provide(crypto));

  const giveBack = Effect.fn("Grants.giveBack")(function* (given: {
    readonly token: string;
    readonly clientId: string | undefined;
  }) {
    const grant = yield* store.findByToken(yield* Secrets.hash(given.token), yield* now);
    if (Option.isNone(grant)) {
      return;
    }
    if (given.clientId !== undefined && given.clientId !== grant.value.clientId) {
      return yield* new GrantRefused({ message: "the token is another app's" });
    }
    yield* store.deleteGrant(grant.value.id);
  }, Effect.provide(crypto));

  const forget = Effect.fn("Grants.forget")(function* () {
    yield* store.deleteClientsNeverGranted(yield* ago(UNGRANTED_LASTS));
    yield* store.deleteExpired(yield* now);
  });

  const list = Effect.fn("Grants.list")(function* (caller: Caller) {
    const account = yield* accountOf(caller);
    return yield* store.listGrants(account.id);
  });

  const revoke = Effect.fn("Grants.revoke")(function* (caller: Caller, id: string) {
    const grant = Option.filter(yield* store.findGrant(id), (found) =>
      reaches(caller, { accountId: found.accountId, workspaceId: null }),
    );
    if (Option.isNone(grant)) {
      return yield* new GrantNotFound({ id });
    }
    yield* store.deleteGrant(grant.value.id);
  });

  return Grants.of({
    register,
    asking,
    approve,
    exchange,
    refresh,
    giveBack,
    forget,
    list,
    revoke,
  });
});

export const layer = Layer.effect(Grants, makeGrants());
