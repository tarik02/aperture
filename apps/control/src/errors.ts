import * as Schema from "effect/Schema";

export * from "@aperture-browser/control-api/errors";

/** The registration token of a keepalive is none that was made. */
export class RegistrationRefused extends Schema.TaggedError<RegistrationRefused>()(
  "RegistrationRefused",
  { message: Schema.String },
) {}

/** A keepalive that does not say what a node has to say of itself. */
export class KeepaliveInvalid extends Schema.TaggedError<KeepaliveInvalid>()("KeepaliveInvalid", {
  message: Schema.String,
}) {}

/** The file given as the ticket key is no Ed25519 private key. */
export class TicketKeyUnusable extends Schema.TaggedError<TicketKeyUnusable>()(
  "TicketKeyUnusable",
  { file: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `the ticket key ${this.file} cannot be used: ${this.reason}`;
  }
}

/** The file given as the master key holds nothing to make keys of. */
export class MasterKeyUnusable extends Schema.TaggedError<MasterKeyUnusable>()(
  "MasterKeyUnusable",
  { file: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `the master key ${this.file} cannot be used: ${this.reason}`;
  }
}

/** A sealed secret that does not open. */
export class Unsealable extends Schema.TaggedError<Unsealable>()("Unsealable", {
  of: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `the secret of ${this.of} does not open: ${this.reason}`;
  }
}

/** A file given for a secret does not hold one. */
export class SecretFileUnusable extends Schema.TaggedError<SecretFileUnusable>()(
  "SecretFileUnusable",
  { file: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `the secret in ${this.file} cannot be used: ${this.reason}`;
  }
}

/** One of the proxies whose word is to be taken is no address and no range of them. */
export class MetricsListenUnusable extends Schema.TaggedError<MetricsListenUnusable>()(
  "MetricsListenUnusable",
  { named: Schema.String },
) {
  override get message() {
    return `${this.named} in APERTURE_CONTROL_METRICS_LISTEN is no address as 127.0.0.1:9465 or [::1]:9465`;
  }
}

export class TrustedProxiesUnusable extends Schema.TaggedError<TrustedProxiesUnusable>()(
  "TrustedProxiesUnusable",
  { named: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `${this.named} in APERTURE_CONTROL_TRUSTED_PROXIES is no address and no range: ${this.reason}`;
  }
}

/** The providers people sign in through are not said as they are read. */
export class ProvidersUnusable extends Schema.TaggedError<ProvidersUnusable>()(
  "ProvidersUnusable",
  { reason: Schema.String },
) {
  override get message() {
    return `the providers in APERTURE_CONTROL_SSO_PROVIDERS cannot be used: ${this.reason}`;
  }
}

/** What an app says of itself when it registers is nothing to register it by. */
export class ClientInvalid extends Schema.TaggedError<ClientInvalid>()("ClientInvalid", {
  message: Schema.String,
}) {}

/** What an app brought for tokens gets it none. */
export class GrantRefused extends Schema.TaggedError<GrantRefused>()("GrantRefused", {
  message: Schema.String,
}) {}

/** A provider does not tell how it is reached, or tells what nobody is signed in by. */
export class DiscoveryFailed extends Schema.TaggedError<DiscoveryFailed>()("DiscoveryFailed", {
  /** Why, each a sentence an admin reads. */
  problems: Schema.Array(Schema.String),
}) {}

/** A variable that says a setting for the deployment says nothing that setting takes. */
export class SettingDefaultUnusable extends Schema.TaggedError<SettingDefaultUnusable>()(
  "SettingDefaultUnusable",
  { variable: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `${this.variable} cannot be used: ${this.reason}`;
  }
}
