import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Settings } from "./service.ts";

const given = Config.all({
  databaseUrl: Config.Redacted("APERTURE_CONTROL_DATABASE_URL"),
  listenHost: Config.String("APERTURE_CONTROL_LISTEN_HOST").pipe(Config.withDefault("127.0.0.1")),
  listenPort: Config.Port("APERTURE_CONTROL_LISTEN_PORT").pipe(Config.withDefault(7800)),
  internalUrl: Config.option(Config.NonEmptyString("APERTURE_CONTROL_INTERNAL_URL")),
  consoleDir: Config.option(Config.NonEmptyString("APERTURE_CONTROL_CONSOLE_DIR")),
  bootstrapToken: Config.Redacted("APERTURE_CONTROL_BOOTSTRAP_TOKEN"),
  masterKeyFile: Config.NonEmptyString("APERTURE_CONTROL_MASTER_KEY"),
  ticketKeyFile: Config.NonEmptyString("APERTURE_CONTROL_TICKET_KEY"),
  ticketLifetime: Config.Duration("APERTURE_CONTROL_TICKET_LIFETIME").pipe(
    Config.withDefault(Duration.minutes(10)),
  ),
  nodeSilentAfter: Config.Duration("APERTURE_CONTROL_NODE_SILENT_AFTER").pipe(
    Config.withDefault(Duration.seconds(30)),
  ),
});

/** The settings as the environment gives them. */
export const makeSettings = Effect.fn("Settings.make")(function* () {
  const { internalUrl, ...settings } = yield* given;
  return Settings.of({
    ...settings,
    internalUrl: Option.getOrElse(
      internalUrl,
      () => `http://${settings.listenHost}:${settings.listenPort}`,
    ).replace(/\/+$/u, ""),
  });
});

export const layer = Layer.effect(Settings, makeSettings());
