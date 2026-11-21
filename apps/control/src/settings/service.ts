import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

/** What the control plane is told when it starts. */
export interface SettingsShape {
  /** The PostgreSQL database, as `postgres://user:password@host:port/database`. */
  readonly databaseUrl: Redacted.Redacted;
  readonly listenHost: string;
  readonly listenPort: number;
  /**
   * Where a proxy before the nodes reaches this program, such as `http://10.0.0.2:7800`.
   * The address it listens on by default.
   */
  readonly internalUrl: string;
  /**
   * A directory with the console as it is built, which this program then serves beside
   * its API; none where something else serves the console, or nobody uses one.
   */
  readonly consoleDir: Option.Option<string>;
  /** Lets its holder do what an admin does before there is any account. */
  readonly bootstrapToken: Redacted.Redacted;
  /**
   * A file with the master key: at least 32 bytes nobody guesses, such as what
   * `openssl rand -base64 32` gives. Secrets the control plane has to read again are
   * sealed with it, so it stays the same for as long as they are to be read.
   */
  readonly masterKeyFile: string;
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
