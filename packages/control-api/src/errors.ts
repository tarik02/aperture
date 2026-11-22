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

/** There is no such registration token. */
export class RegistrationTokenNotFound extends Schema.TaggedError<RegistrationTokenNotFound>()(
  "RegistrationTokenNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** There is no such workspace, or the caller is not in it: the two are told alike. */
export class WorkspaceNotFound extends Schema.TaggedError<WorkspaceNotFound>()(
  "WorkspaceNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The workspace still has sessions or snapshots, so it is not removed. */
export class WorkspaceInUse extends Schema.TaggedError<WorkspaceInUse>()(
  "WorkspaceInUse",
  { id: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Someone signs in with that email address already. */
export class EmailTaken extends Schema.TaggedError<EmailTaken>()(
  "EmailTaken",
  { email: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Nobody signs in with that email address, or the account is no person's. */
export class PersonNotFound extends Schema.TaggedError<PersonNotFound>()(
  "PersonNotFound",
  { email: Schema.String },
  { httpApiStatus: 404 },
) {}

/** What was asked for an account does not go together. */
export class AccountInvalid extends Schema.TaggedError<AccountInvalid>()(
  "AccountInvalid",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** The account is not disabled or removed while something still stands on it. */
export class AccountInUse extends Schema.TaggedError<AccountInUse>()(
  "AccountInUse",
  { id: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** No app registered as that. */
export class OAuthClientNotFound extends Schema.TaggedError<OAuthClientNotFound>()(
  "OAuthClientNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** An app asks to be answered where it did not say it is. */
export class RedirectRefused extends Schema.TaggedError<RedirectRefused>()(
  "RedirectRefused",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** There is no such grant, or it is another account's: the two are told alike. */
export class GrantNotFound extends Schema.TaggedError<GrantNotFound>()(
  "GrantNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** There is no such share link, or it is into another session: the two are told alike. */
export class ShareNotFound extends Schema.TaggedError<ShareNotFound>()(
  "ShareNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** What a guest came with is no share link, or one that ran out or was taken back. */
export class ShareRefused extends Schema.TaggedError<ShareRefused>()(
  "ShareRefused",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/** Too many share links that are none came from one address in a while. */
export class TooManyTries extends Schema.TaggedError<TooManyTries>()(
  "TooManyTries",
  { message: Schema.String },
  { httpApiStatus: 429 },
) {}

/** There is no such provider among those that are kept here. */
export class ProviderNotFound extends Schema.TaggedError<ProviderNotFound>()(
  "ProviderNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** A provider is known by that id already: one that is kept here, or one the settings name. */
export class ProviderTaken extends Schema.TaggedError<ProviderTaken>()(
  "ProviderTaken",
  { id: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The provider is named by the settings: it is changed and removed there, and not here. */
export class ProviderConfigured extends Schema.TaggedError<ProviderConfigured>()(
  "ProviderConfigured",
  { id: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

/**
 * What was said of a provider is nothing to sign people in through: `problems` are the
 * reasons, each a sentence, where there are several.
 */
export class ProviderInvalid extends Schema.TaggedError<ProviderInvalid>()(
  "ProviderInvalid",
  { message: Schema.String, problems: Schema.Array(Schema.String) },
  { httpApiStatus: 400 },
) {}
