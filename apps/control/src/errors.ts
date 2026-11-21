import * as Schema from "effect/Schema";

/** No token came with the request, or one that is nobody's. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/** The caller is known, and this is not theirs to do. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()(
  "AccountNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** There is no such session, or it is another account's: the two are told alike. */
export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** No node is there to run a session: none registered, all silent, or none answered. */
export class NoNode extends Schema.TaggedError<NoNode>()(
  "NoNode",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** The session is on no node, so nothing can be asked of it. */
export class SessionHasNoNode extends Schema.TaggedError<SessionHasNoNode>()(
  "SessionHasNoNode",
  { id: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The session's node is silent or did not answer. */
export class NodeUnreachable extends Schema.TaggedError<NodeUnreachable>()(
  "NodeUnreachable",
  { node: Schema.String, message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** The node answered that it does not do this; `code` is the executor's own. */
export class NodeRefused extends Schema.TaggedError<NodeRefused>()(
  "NodeRefused",
  { node: Schema.String, code: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

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

/** There is no such snapshot, or it is another account's: the two are told alike. */
export class SnapshotNotFound extends Schema.TaggedError<SnapshotNotFound>()(
  "SnapshotNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}
