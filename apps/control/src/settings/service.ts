import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import type * as Redacted from "effect/Redacted";

/** What the control plane is told when it starts. */
export interface SettingsShape {
  /** The PostgreSQL database, as `postgres://user:password@host:port/database`. */
  readonly databaseUrl: Redacted.Redacted;
  readonly listenHost: string;
  readonly listenPort: number;
  /** Lets its holder do what an admin does before there is any account. */
  readonly bootstrapToken: Redacted.Redacted;
  /** The Ed25519 private key tickets are signed with: PKCS#8, as PEM. */
  readonly ticketKeyFile: string;
  /** How long a ticket is good for. */
  readonly ticketLifetime: Duration.Duration;
  /** How long a node may send no keepalive before it is not used. */
  readonly nodeSilentAfter: Duration.Duration;
}

export class Settings extends Context.Service<Settings, SettingsShape>()(
  "@aperture-browser/control/Settings",
) {}

/** How often a node is asked to send its keepalive: a few are lost before it counts as silent. */
export const keepaliveEvery = (settings: SettingsShape) =>
  Duration.divideUnsafe(settings.nodeSilentAfter, 3);
