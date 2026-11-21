import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { SecretFileUnusable } from "../errors.ts";
import { Settings } from "./service.ts";

const given = Config.all({
  databaseUrl: Config.Redacted("APERTURE_CONTROL_DATABASE_URL"),
  listenHost: Config.String("APERTURE_CONTROL_LISTEN_HOST").pipe(Config.withDefault("127.0.0.1")),
  listenPort: Config.Port("APERTURE_CONTROL_LISTEN_PORT").pipe(Config.withDefault(7800)),
  internalUrl: Config.option(Config.NonEmptyString("APERTURE_CONTROL_INTERNAL_URL")),
  publicUrl: Config.option(Config.NonEmptyString("APERTURE_CONTROL_PUBLIC_URL")),
  consoleDir: Config.option(Config.NonEmptyString("APERTURE_CONTROL_CONSOLE_DIR")),
  // A secret is given as it is, or as a file that holds it: the second is how whatever
  // sets a machine up hands secrets over.
  bootstrapToken: Config.option(Config.Redacted("APERTURE_CONTROL_BOOTSTRAP_TOKEN")),
  bootstrapTokenFile: Config.option(Config.NonEmptyString("APERTURE_CONTROL_BOOTSTRAP_TOKEN_FILE")),
  proxyTokenFile: Config.option(Config.NonEmptyString("APERTURE_CONTROL_PROXY_TOKEN_FILE")),
  registrationTokenFile: Config.option(
    Config.NonEmptyString("APERTURE_CONTROL_REGISTRATION_TOKEN_FILE"),
  ),
  masterKeyFile: Config.NonEmptyString("APERTURE_CONTROL_MASTER_KEY"),
  ticketKeyFile: Config.NonEmptyString("APERTURE_CONTROL_TICKET_KEY"),
  ticketLifetime: Config.Duration("APERTURE_CONTROL_TICKET_LIFETIME").pipe(
    Config.withDefault(Duration.minutes(10)),
  ),
  nodeSilentAfter: Config.Duration("APERTURE_CONTROL_NODE_SILENT_AFTER").pipe(
    Config.withDefault(Duration.seconds(30)),
  ),
});

/** The secret a file holds, less the space around it. */
const secretIn = Effect.fn("Settings.secretIn")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const read = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError((error) => new SecretFileUnusable({ file, reason: error.message })));
  if (read.trim() === "") {
    return yield* new SecretFileUnusable({ file, reason: "it is empty" });
  }
  return Redacted.make(read.trim());
});

const optionalSecretIn = (file: Option.Option<string>) =>
  Option.match(file, {
    onNone: () => Effect.succeed(Option.none<Redacted.Redacted>()),
    onSome: (named) => Effect.map(secretIn(named), Option.some),
  });

/** The settings as the environment gives them. */
export const makeSettings = Effect.fn("Settings.make")(function* () {
  const {
    internalUrl,
    bootstrapToken,
    bootstrapTokenFile,
    proxyTokenFile,
    registrationTokenFile,
    ...settings
  } = yield* given;
  const fromFile = yield* optionalSecretIn(bootstrapTokenFile);
  const bootstrap = Option.orElse(bootstrapToken, () => fromFile);
  if (Option.isNone(bootstrap)) {
    return yield* new SecretFileUnusable({
      file: "APERTURE_CONTROL_BOOTSTRAP_TOKEN_FILE",
      reason: "neither the bootstrap token nor a file that holds it is given",
    });
  }
  return Settings.of({
    ...settings,
    bootstrapToken: bootstrap.value,
    proxyToken: yield* optionalSecretIn(proxyTokenFile),
    registrationToken: yield* optionalSecretIn(registrationTokenFile),
    internalUrl: Option.getOrElse(
      internalUrl,
      () => `http://${settings.listenHost}:${settings.listenPort}`,
    ).replace(/\/+$/u, ""),
  });
});

export const layer = Layer.effect(Settings, makeSettings());
