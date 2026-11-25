import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ApiToken } from "../accounts/schemas.ts";
import type { NewApiToken } from "../accounts/store.ts";
import type { Vault } from "../vault/service.ts";

/** How many of what v1 kept are still kept as v1 kept them. */
export interface Unconverted {
  /** Tokens that are good and were not used since they were moved. */
  readonly tokens: number;
  /** Passwords nobody signed in with since. */
  readonly passwords: number;
}

/**
 * What Aperture v1 kept of how its people and its API tokens prove themselves, as
 * `aperture-migrate` brings it along so that nobody is given new ones. Each is checked as
 * v1 checked it, once: what passes is kept from then on as v2 keeps its own, and is
 * nothing of this any more. It is all of v2 that knows of v1's ways, and goes, with its
 * table, once nothing is left as v1 kept it.
 */
export interface V1CredentialsShape {
  /** Keeps a token of v1 under its id, which works once it is first used. */
  readonly keepToken: (
    token: Omit<NewApiToken, "tokenHash">,
    /** bcrypt of the token's secret, as v1 kept it. */
    digest: string,
  ) => Effect.Effect<ApiToken>;
  /**
   * Gives the person of an account the password and the second factor they had in v1. It
   * is asked of the vault, which seals the second factor, by `aperture-migrate` alone: the
   * stores this is among are made without one.
   */
  readonly keepSignIn: (
    accountId: string,
    kept: {
      /** Argon2id, as a PHC string. */
      readonly password: string | null;
      /** An authenticator's secret in base32, of codes of six digits every 30 seconds. */
      readonly secondFactor: string | null;
    },
  ) => Effect.Effect<void, never, Vault>;
  /**
   * Where a bearer is a token of v1 that was kept and is good, keeps it as v2 keeps its
   * own, which then finds it. Anything else stays as it is.
   */
  readonly convertToken: (bearer: string) => Effect.Effect<void>;
  /**
   * Whether a password is the one a digest of v1 is of. One that is replaces the digest
   * with one of v2's own.
   */
  readonly checkPassword: (digest: string, password: string) => Effect.Effect<boolean>;
  readonly unconverted: () => Effect.Effect<Unconverted>;
}

export class V1Credentials extends Context.Service<V1Credentials, V1CredentialsShape>()(
  "@aperture-browser/control/V1Credentials",
) {}

/** Whether a password's digest is one v1 made, which v2 makes none of. */
export const isV1Password = (digest: string) => digest.startsWith("$argon2id$");
