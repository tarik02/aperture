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
