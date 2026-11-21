import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Unsealable } from "../errors.ts";

/**
 * Keeps secrets the control plane has to read again, so that the database alone does not
 * give them away: they are sealed with the master key, which is not in it.
 */
export interface VaultShape {
  /** Seals a secret. `of` names whose it is: what is sealed opens under no other name. */
  readonly seal: (secret: string, of: string) => Effect.Effect<string>;
  readonly open: (sealed: string, of: string) => Effect.Effect<string, Unsealable>;
}

export class Vault extends Context.Service<Vault, VaultShape>()(
  "@aperture-browser/control/Vault",
) {}
