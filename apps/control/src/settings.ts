import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

const settings = Config.all({
  databaseUrl: Config.Redacted("APERTURE_CONTROL_DATABASE_URL"),
  listenHost: Config.String("APERTURE_CONTROL_LISTEN_HOST").pipe(Config.withDefault("127.0.0.1")),
  listenPort: Config.Port("APERTURE_CONTROL_LISTEN_PORT").pipe(Config.withDefault(7800)),
  bootstrapToken: Config.Redacted("APERTURE_CONTROL_BOOTSTRAP_TOKEN"),
  ticketKeyFile: Config.NonEmptyString("APERTURE_CONTROL_TICKET_KEY"),
  ticketLifetime: Config.Duration("APERTURE_CONTROL_TICKET_LIFETIME").pipe(
    Config.withDefault(Duration.minutes(10)),
  ),
  nodeSilentAfter: Config.Duration("APERTURE_CONTROL_NODE_SILENT_AFTER").pipe(
    Config.withDefault(Duration.seconds(30)),
  ),
});

export class Settings extends Context.Service<Settings, SettingsShape>()(
  "@aperture-browser/control/Settings",
) {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function* () {
      return yield* settings;
    }),
  );
}

/** How often a node is asked to send its keepalive: a few are lost before it counts as silent. */
export const keepaliveEvery = (settings: SettingsShape) =>
  Duration.divideUnsafe(settings.nodeSilentAfter, 3);
