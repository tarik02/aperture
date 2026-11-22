import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SecretsFileUnusable } from "../errors.ts";

/** A token that was made in place of one of v1's, with its secret, which is told once. */
export interface Reissued {
  /** The token of v1 it is in place of. */
  readonly v1Id: string;
  readonly id: string;
  readonly account: string;
  readonly name: string;
  readonly secret: string;
}

/** Where the secrets of the tokens made anew go, for whoever hands them to their holders. */
export interface TokenSecretsShape {
  readonly keep: (token: Reissued) => Effect.Effect<void, SecretsFileUnusable>;
}

export class TokenSecrets extends Context.Service<TokenSecrets, TokenSecretsShape>()(
  "@aperture-browser/migrate/TokenSecrets",
) {}
