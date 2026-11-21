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

/** There is no such snapshot, or it is another account's: the two are told alike. */
export class SnapshotNotFound extends Schema.TaggedError<SnapshotNotFound>()(
  "SnapshotNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The session is on another node than the request went to: `path` is where it is now. */
export class SessionElsewhere extends Schema.TaggedError<SessionElsewhere>()(
  "SessionElsewhere",
  { id: Schema.String, path: Schema.String },
  { httpApiStatus: 409 },
) {}

/** There is no such API token, or it is another account's: the two are told alike. */
export class ApiTokenNotFound extends Schema.TaggedError<ApiTokenNotFound>()(
  "ApiTokenNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}
