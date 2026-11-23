import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ProvidersUnusable, SecretFileUnusable, TrustedProxiesUnusable } from "../errors.ts";
import { network } from "../http/client-address.ts";
import { type Provider, Settings } from "./service.ts";

const listed = (list: string) =>
  list
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one !== "");

/**
 * The providers as they are given: a JSON array, each with its issuer or the address of
 * its discovery document, and its client secret as the file that holds it.
 */
const Providers = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      // It is part of an address, and `credential` is what a password is kept as.
      id: Schema.String.check(Schema.isPattern(/^(?!credential$)[a-z0-9][a-z0-9-]*$/u)),
      name: Schema.optional(Schema.NonEmptyString),
      issuer: Schema.optional(Schema.NonEmptyString),
      discoveryUrl: Schema.optional(Schema.NonEmptyString),
      clientId: Schema.NonEmptyString,
      clientSecretFile: Schema.NonEmptyString,
    }),
  ),
);

const given = Config.all({
  databaseUrl: Config.Redacted("APERTURE_CONTROL_DATABASE_URL"),
  listenHost: Config.String("APERTURE_CONTROL_LISTEN_HOST").pipe(Config.withDefault("127.0.0.1")),
  listenPort: Config.Port("APERTURE_CONTROL_LISTEN_PORT").pipe(Config.withDefault(7800)),
  internalUrl: Config.option(Config.NonEmptyString("APERTURE_CONTROL_INTERNAL_URL")),
  publicUrl: Config.option(Config.NonEmptyString("APERTURE_CONTROL_PUBLIC_URL")),
  // This machine's own by default: a proxy beside the program is the usual one.
  trustedProxies: Config.String("APERTURE_CONTROL_TRUSTED_PROXIES").pipe(
    Config.withDefault("127.0.0.0/8,::1"),
    Config.map(listed),
  ),
  providers: Config.String("APERTURE_CONTROL_SSO_PROVIDERS").pipe(Config.withDefault("[]")),
  provisionPeople: Config.Boolean("APERTURE_CONTROL_SSO_PROVISION").pipe(Config.withDefault(false)),
  provisionDomains: Config.String("APERTURE_CONTROL_SSO_DOMAINS").pipe(
    Config.withDefault(""),
    Config.map((list) => listed(list).map((domain) => domain.toLowerCase())),
  ),
  providersOnLoopback: Config.Boolean("APERTURE_CONTROL_SSO_LOOPBACK_HTTP").pipe(
    Config.withDefault(false),
  ),
  rateLimit: Config.Boolean("APERTURE_CONTROL_RATE_LIMIT").pipe(Config.withDefault(true)),
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
  eventsKeep: Config.Duration("APERTURE_CONTROL_EVENTS_KEEP").pipe(
    Config.withDefault(Duration.days(90)),
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

/** The providers a setting names, each with the secret its file holds. */
const providersIn = Effect.fn("Settings.providersIn")(function* (given: string) {
  const named = yield* Schema.decodeUnknownEffect(Providers)(given).pipe(
    Effect.mapError((error) => new ProvidersUnusable({ reason: error.message })),
  );
  const ids = new Set(named.map((provider) => provider.id));
  if (ids.size !== named.length) {
    return yield* new ProvidersUnusable({ reason: "two of them have one id" });
  }
  return yield* Effect.forEach(
    named,
    Effect.fn(function* ({ id, name, issuer, discoveryUrl, clientId, clientSecretFile }) {
      const discovery =
        discoveryUrl ??
        (issuer === undefined
          ? undefined
          : `${issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`);
      if (discovery === undefined) {
        return yield* new ProvidersUnusable({
          reason: `${id} names neither its issuer nor its discovery document`,
        });
      }
      return {
        id,
        name: name ?? id,
        discoveryUrl: discovery,
        clientId,
        clientSecret: yield* secretIn(clientSecretFile),
      } satisfies Provider;
    }),
  );
});

/** The settings as the environment gives them. */
export const makeSettings = Effect.fn("Settings.make")(function* () {
  const {
    internalUrl,
    bootstrapToken,
    bootstrapTokenFile,
    proxyTokenFile,
    registrationTokenFile,
    providers,
    trustedProxies,
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
  // One that is misspelt would be trusted for nothing, and nobody told.
  const trusted = yield* Effect.forEach(trustedProxies, (named) =>
    Result.match(network(named), {
      onSuccess: Effect.succeed,
      onFailure: (error) =>
        Effect.fail(new TrustedProxiesUnusable({ named, reason: error.message })),
    }),
  );
  return Settings.of({
    ...settings,
    trustedProxies: trusted,
    bootstrapToken: bootstrap.value,
    providers: yield* providersIn(providers),
    proxyToken: yield* optionalSecretIn(proxyTokenFile),
    registrationToken: yield* optionalSecretIn(registrationTokenFile),
    internalUrl: Option.getOrElse(
      internalUrl,
      () => `http://${settings.listenHost}:${settings.listenPort}`,
    ).replace(/\/+$/u, ""),
  });
});

export const layer = Layer.effect(Settings, makeSettings());
