import type { Scope, TokenResources } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Client, Grant } from "./schemas.ts";

export interface NewClient {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
  readonly createdAt: Date;
}

export interface NewGrant {
  readonly id: string;
  readonly accountId: string;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<Scope>;
  readonly resources: TokenResources | null;
  readonly createdAt: Date;
}

export interface NewCode {
  readonly codeHash: string;
  readonly grantId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly expiresAt: Date;
}

/** What a code was made with, which whoever exchanges it has to match. */
export interface Code {
  readonly grantId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
}

export interface NewToken {
  readonly tokenHash: string;
  readonly grantId: string;
  readonly kind: "access" | "refresh";
  readonly expiresAt: Date;
}

/** Where the apps that registered, people's grants to them and the grants' tokens are kept. */
export interface GrantsStoreShape {
  readonly insertClient: (client: NewClient) => Effect.Effect<Client>;
  readonly findClient: (id: string) => Effect.Effect<Option.Option<Client>>;
  /** Removes the apps that registered before then and were given no grant since, by anyone. */
  readonly deleteClientsNeverGranted: (before: Date) => Effect.Effect<void>;
  /** Keeps a grant in place of any the account gave the same app before. */
  readonly insertGrant: (grant: NewGrant) => Effect.Effect<void>;
  readonly listGrants: (accountId: string) => Effect.Effect<ReadonlyArray<Grant>>;
  readonly findGrant: (id: string) => Effect.Effect<Option.Option<Grant>>;
  /** Removes a grant, and with it every code and token of it. */
  readonly deleteGrant: (id: string) => Effect.Effect<void>;
  readonly insertCode: (code: NewCode) => Effect.Effect<void>;
  /** A code that is still good, by its digest. It is gone from then on: a code is used once. */
  readonly takeCode: (codeHash: string, now: Date) => Effect.Effect<Option.Option<Code>>;
  readonly insertToken: (token: NewToken) => Effect.Effect<void>;
  /** The grant of a refresh token that is still good; the token is gone from then on. */
  readonly takeRefreshToken: (tokenHash: string, now: Date) => Effect.Effect<Option.Option<Grant>>;
  /** The grant of an access token that is still good. */
  readonly findByAccessToken: (tokenHash: string, now: Date) => Effect.Effect<Option.Option<Grant>>;
  /** The grant of a token of either kind that is still good. */
  readonly findByToken: (tokenHash: string, now: Date) => Effect.Effect<Option.Option<Grant>>;
  /** Removes the codes and tokens that ran out: they are good for nothing. */
  readonly deleteExpired: (now: Date) => Effect.Effect<void>;
}

export class GrantsStore extends Context.Service<GrantsStore, GrantsStoreShape>()(
  "@aperture-browser/control/GrantsStore",
) {}
