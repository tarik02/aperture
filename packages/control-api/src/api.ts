import * as Context from "effect/Context";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Schema from "effect/Schema";
import manifest from "../package.json" with { type: "json" };
import type { Caller } from "./caller.ts";
import {
  AccountInUse,
  AccountInvalid,
  AccountNotFound,
  ApiTokenNotFound,
  EmailTaken,
  FileLinkInvalid,
  PersonNotFound,
  Forbidden,
  ProviderConfigured,
  ProviderInvalid,
  ProviderNotFound,
  ProviderTaken,
  QuotaExceeded,
  GrantNotFound,
  NodeNotFound,
  NodeRefused,
  NodeUnreachable,
  NoNode,
  OAuthClientNotFound,
  RedirectRefused,
  RegistrationTokenNotFound,
  SessionHasNoNode,
  SessionNotFound,
  SettingInvalid,
  SettingOutOfBounds,
  ShareNotFound,
  SnapshotNotFound,
  Unauthorized,
  WorkspaceInUse,
  WorkspaceNotFound,
} from "./errors.ts";
import {
  Access,
  DesiredState,
  EventActor,
  EventDetail,
  EventKind,
  EventResource,
  ObservedState,
  Offers,
  ProxyConfig,
  Scope,
  ShareRole,
  TokenResources,
} from "./schemas.ts";
import { SettingEntry, SettingKey, SettingView, SettingViews } from "./policy.ts";

/** Where the control plane's API is, apart from the routes of sessions and of nodes. */
export const PREFIX = "/api/control";

const WorkspaceRole = Schema.Literals(["member", "admin"]);

export const Account = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  admin: Schema.Boolean,
  /** A person, who signs in, or a service, which comes with API tokens alone. */
  kind: Schema.Literals(["person", "service"]),
  /** The address a person signs in with; none for a service. */
  email: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  /** Since when it is disabled: nothing of it signs in or is taken as a caller. */
  disabledAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

/**
 * The account a caller is, with what the caller itself may do as it: what the token it came
 * with is held to. Whoever signed in with cookies is held to nothing.
 */
export const CurrentAccount = Schema.Struct({
  ...Account.fields,
  /** What the caller is held to; none for one that does whatever its account does. */
  scopes: Schema.NullOr(Schema.Array(Scope)),
  /** The resources the caller is held to; none for one that reaches all its account does. */
  resources: Schema.NullOr(TokenResources),
});

/** What a person signs in with. */
export const SignInMethods = Schema.Struct({
  /** Whether they have a password: one they set, since nobody is given one. */
  password: Schema.Boolean,
  secondFactor: Schema.Boolean,
  /** How many passkeys they added. */
  passkeys: Schema.Number,
  /** The providers they came through, by what each is called. */
  providers: Schema.Array(Schema.String),
});

/** An account as an admin is told of it: with what its person signs in with, for a person's. */
export const ListedAccount = Schema.Struct({
  ...Account.fields,
  signIn: Schema.NullOr(SignInMethods),
});

/** A workspace as its caller has it: `role` is none for an admin who is no member. */
export const Workspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  role: Schema.NullOr(WorkspaceRole),
});

/** A workspace an account is in, with what the account does there. */
export const AccountWorkspace = Schema.Struct({
  ...Workspace.fields,
  role: WorkspaceRole,
});

export const WorkspaceMember = Schema.Struct({
  accountId: Schema.String,
  name: Schema.String,
  kind: Account.fields.kind,
  /** The address a person signs in with; none for a service. */
  email: Account.fields.email,
  role: WorkspaceRole,
});

/** A person's account as whoever asked for it by its address is told of it. */
export const AccountLookup = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
});

/** An API token as its account sees it: never the token. */
export const ApiToken = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** What it is held to. */
  scopes: Schema.Array(Scope),
  /** The resources it is held to; none for a token that reaches all its account does. */
  resources: Schema.NullOr(TokenResources),
});

/** A token as it is told once, when it is made. */
export const ApiTokenCreated = Schema.Struct({ ...ApiToken.fields, token: Schema.String });

const NewApiToken = Schema.Struct({
  name: Schema.NonEmptyString,
  /** How many days it is good for; for as long as it is not taken back, without. */
  /** What it does: a token is made for something, and does nothing else. */
  scopes: Schema.NonEmptyArray(Scope),
  /** The resources it is held to; all that its account reaches, without. */
  resources: Schema.optional(TokenResources),
  expiresInDays: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 }))),
});

export const RegistrationToken = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  /** Since when it registers no new node; the nodes that registered with it stay. */
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

export const RegistrationTokenCreated = Schema.Struct({
  ...RegistrationToken.fields,
  token: Schema.String,
});

/** A node as its admin sees it: without the operator token. */
export const Node = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  internalUrl: Schema.String,
  balancerUrl: Schema.NullOr(Schema.String),
  publicUrl: Schema.NullOr(Schema.String),
  offers: Schema.NullOr(Offers),
  registeredAt: Schema.DateTimeUtcFromString,
  lastSeenAt: Schema.DateTimeUtcFromString,
  /** Whether its last keepalive is recent enough for it to be used. */
  alive: Schema.Boolean,
});

export const Session = Schema.Struct({
  id: Schema.String,
  /**
   * The account that made it. A session of no workspace is that account's own; one of a
   * workspace is the workspace's, and names none where nobody is known to have made it
   * or the account was removed since.
   */
  accountId: Schema.NullOr(Schema.String),
  workspaceId: Schema.NullOr(Schema.String),
  nodeId: Schema.NullOr(Schema.String),
  /** What the node it is on is called; none for a session on no node. */
  nodeName: Schema.NullOr(Schema.String),
  desiredState: DesiredState,
  observedState: ObservedState,
  failure: Schema.NullOr(Schema.String),
  unreachableSince: Schema.NullOr(Schema.DateTimeUtcFromString),
  snapshotId: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  observedAt: Schema.DateTimeUtcFromString,
  /**
   * Where the session is reached through a proxy before the nodes, below the proxy's own
   * address; none for a session on no node. It changes when the session moves.
   */
  path: Schema.NullOr(Schema.String),
  /** Whether it is kept from being deleted by itself, as its settings would have it. */
  pinned: Schema.Boolean,
  /** Since when its node says it is suspended, while it says so. */
  suspendedSince: Schema.NullOr(Schema.DateTimeUtcFromString),
});

export const Snapshot = Schema.Struct({
  id: Schema.String,
  /** The account that made it, as a session's is. */
  accountId: Schema.NullOr(Schema.String),
  workspaceId: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  nodeId: Schema.NullOr(Schema.String),
  shared: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
});

/** What a person gave an app that asked to act as their account. */
export const Grant = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  clientId: Schema.String,
  clientName: Schema.String,
  scopes: Schema.Array(Scope),
  /** The resources it is held to; none for a grant that reaches all its account does. */
  resources: Schema.NullOr(TokenResources),
  createdAt: Schema.DateTimeUtcFromString,
});

/** A provider people sign in through, as the page that signs them in names it. */
export const Provider = Schema.Struct({
  /** What it is known by in addresses. */
  id: Schema.String,
  name: Schema.String,
  /** Which provider's mark it is shown with, as whoever added it said; none said, without. */
  icon: Schema.NullOr(Schema.String),
});

/** What a provider is known by: a part of the address it sends people back to. */
export const ProviderId = Schema.String.check(
  // `credential` is what a password is kept as, among what people sign in with.
  Schema.isPattern(/^(?!credential$)[a-z0-9][a-z0-9-]{0,39}$/u),
);

/**
 * Which provider's mark one is shown with, by what that provider is known as among those
 * the console draws: `github`, `google`. One it does not draw is shown with no mark of
 * any provider's; it is for whoever shows providers, and nothing is done by it.
 */
const ProviderIcon = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/u));

/** What is asked of a provider for the people it signs in, each a word of its own. */
const ProviderScopes = Schema.Array(
  Schema.String.check(Schema.isPattern(/^[\x21\x23-\x5b\x5d-\x7e]+$/u)),
);
/** The domains of email addresses, as `example.com`. */
const ProviderDomains = Schema.Array(
  Schema.String.check(
    Schema.isPattern(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/iu),
  ),
);

/**
 * What a provider speaks: OpenID Connect, whose signed token says who someone is, or OAuth
 * 2.0 alone, where that is asked of the provider with the token it gave.
 */
export const ProviderKind = Schema.Literals(["oidc", "oauth2"]);

/**
 * Where a provider that speaks OAuth 2.0 alone is asked: where people are sent, where what
 * they come back with is exchanged for a token, and where the token tells who they are,
 * which is a document with their `id` or `sub`, and their `email` with `email_verified`.
 * Where it lists their addresses apart as GitHub does, each with `primary` and `verified`,
 * the one that is theirs first is taken from there. Nobody signs in on an address the
 * provider does not say it verified.
 */
const ProviderEndpoints = Schema.Struct({
  authorization: Schema.String,
  token: Schema.String,
  userInfo: Schema.String,
  emails: Schema.NullOr(Schema.String),
});
const GivenProviderEndpoints = Schema.Struct({
  authorization: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  userInfo: Schema.NonEmptyString,
  /** None, where it is left out or empty. */
  emails: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * A provider as an admin is told of it: all that was said of it but its client secret,
 * of which only whether there is one is told.
 */
export const SignInProvider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Which provider's mark it is shown with; none said, for one the settings name. */
  icon: Schema.NullOr(Schema.String),
  kind: ProviderKind,
  /**
   * Its issuer, or its discovery document where that was given in place of it; nothing
   * for one that speaks OAuth 2.0 alone, which has `endpoints` in its place.
   */
  issuer: Schema.String,
  endpoints: Schema.NullOr(ProviderEndpoints),
  clientId: Schema.String,
  secretSet: Schema.Boolean,
  scopes: Schema.Array(Schema.String),
  /** Whether someone it vouches for, whom no admin made a person, is made one. */
  provision: Schema.Boolean,
  /** The domains of the addresses people are made for so; any address where none is named. */
  domains: Schema.Array(Schema.String),
  /** Whether people sign in through it now. */
  enabled: Schema.Boolean,
  /** Kept here, where an admin changes it, or named by the settings, which alone change it. */
  source: Schema.Literals(["stored", "configuration"]),
  /** When it was added and last changed here; never, for one the settings name. */
  createdAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  updatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

export const SignInProviders = Schema.Struct({
  /** What a provider is told to send people back to, once its id is put after it. */
  callbackBase: Schema.String,
  providers: Schema.Array(SignInProvider),
});

const NewSignInProvider = Schema.Struct({
  id: ProviderId,
  name: Schema.NonEmptyString,
  icon: Schema.optional(Schema.NullOr(ProviderIcon)),
  /** OpenID Connect, without. It stays what it is said to be here. */
  kind: Schema.optional(ProviderKind),
  /** Of one that speaks OpenID Connect, which has to have one. */
  issuer: Schema.optional(Schema.NonEmptyString),
  /** Of one that speaks OAuth 2.0 alone, which has to have them. */
  endpoints: Schema.optional(GivenProviderEndpoints),
  clientId: Schema.NonEmptyString,
  /** Told here and never again. */
  clientSecret: Schema.NonEmptyString,
  /** `openid email profile` without, and none for one that speaks OAuth 2.0 alone. */
  scopes: Schema.optional(ProviderScopes),
  provision: Schema.optional(Schema.Boolean),
  domains: Schema.optional(ProviderDomains),
  /** One that is not enabled is kept whether or not it is reached. */
  enabled: Schema.optional(Schema.Boolean),
});

/** What is said anew of a provider; what is left out stays as it was. */
const ChangedSignInProvider = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  /** Given as none, it is shown with no provider's mark from then on. */
  icon: Schema.optional(Schema.NullOr(ProviderIcon)),
  issuer: Schema.optional(Schema.NonEmptyString),
  endpoints: Schema.optional(GivenProviderEndpoints),
  clientId: Schema.optional(Schema.NonEmptyString),
  /** The secret it has stays where none is given, or an empty one. */
  clientSecret: Schema.optional(Schema.String),
  scopes: Schema.optional(ProviderScopes),
  provision: Schema.optional(Schema.Boolean),
  domains: Schema.optional(ProviderDomains),
  enabled: Schema.optional(Schema.Boolean),
});

/** What came of asking a provider how it is reached: nothing wrong, or why not. */
export const ProviderChecked = Schema.Struct({
  ok: Schema.Boolean,
  /** What is wrong, each a sentence; nothing where it is reached as it should be. */
  problems: Schema.Array(Schema.String),
  /** The scopes it says it gives, where it is reached and says any. */
  scopes: Schema.Array(Schema.String),
});

/** A ticket into a session, as it is told to whoever asked for it. */
export const Admission = Schema.Struct({
  /** What a request to the session carries: as a bearer token, or as `token` in its query. */
  ticket: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
  /**
   * The session's workbench, for a person to open in a browser: on its node where that
   * has an address of its own, and through the proxy before the nodes otherwise. What
   * comes before its `?` is where the session's other routes are.
   */
  url: Schema.String,
});

/** What a file of a session is found by, below its files: `recordings/1a2b.mkv`. */
export const SessionFilePath = Schema.String.check(
  Schema.isPattern(/^(uploads|downloads|recordings|screenshots)(\/(?!\.)[^/\\?#]+)+$/u),
);

/** An address one file of a session is read at, or put to, by whoever is given it. */
export const FileLink = Schema.Struct({
  url: Schema.String,
  /** What a request to it is made with: `GET` reads the file, `PUT` puts its bytes there. */
  method: Schema.Literals(["GET", "PUT"]),
  expiresAt: Schema.DateTimeUtcFromString,
});

/** The longest a file link is good for, in seconds. */
export const FILE_LINK_MOST = 3600;

/** A share link as whoever has its session sees it: never its secret. */
export const Share = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  /** The account that made it. */
  accountId: Schema.String,
  /** Whom it is for, as whoever made it said; none where they did not. */
  name: Schema.NullOr(Schema.String),
  role: ShareRole,
  /** The number of the one tab its guests see; the whole session, without. */
  tab: Schema.NullOr(Schema.Int),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

/** A link as it is told once, when it is made: `url` is what a guest opens. */
export const ShareCreated = Schema.Struct({ ...Share.fields, url: Schema.String });

/** Something that was done, by whom and to what: written once, and never changed. */
export const Event = Schema.Struct({
  id: Schema.String,
  at: Schema.DateTimeUtcFromString,
  kind: EventKind,
  actor: EventActor,
  /** What it was about; nothing where that is not known, as with whoever nobody knows. */
  resource: Schema.NullOr(EventResource),
  /** The workspace what it was about is of, where it is of one. */
  workspaceId: Schema.NullOr(Schema.String),
  /** Where the request that did it came from, where one did and that is known. */
  address: Schema.NullOr(Schema.String),
  detail: EventDetail,
});

/** Events, the newest first, and what the ones after them are asked for with. */
export const EventPage = Schema.Struct({
  events: Schema.Array(Event),
  /** The cursor of the events before these; none where these are the oldest. */
  next: Schema.NullOr(Schema.String),
});

/** Who the request comes from, for what handles it. */
export class CurrentCaller extends Context.Service<CurrentCaller, Caller>()(
  "@aperture-browser/control/CurrentCaller",
) {}

/** Lets in whoever comes with an account's API token, or with the bootstrap token. */
export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  { provides: CurrentCaller }
>()("@aperture-browser/control/Authorization", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized,
}) {}

/**
 * What an account, a workspace, an API token, a grant or a share link is found by. A path
 * that names one by anything else names nothing, and is refused before it is looked for.
 */
const Id = Schema.String.check(Schema.isUUID());
const session = { id: Schema.String };
/** What a session or a snapshot is found by: names, each with what it is set to. */
const Tags = Schema.Record(Schema.NonEmptyString, Schema.String);
/** A session's routing as it was last set through the control plane; none goes direct. */
const SessionProxy = Schema.Struct({ proxy: Schema.NullOr(ProxyConfig) });
/** A tag something is listed by: `name=value`, or `name` alone for whatever it is set to. */
const TagFilter = Schema.NonEmptyString;
/** `none` for what is of no workspace: its account's own. */
const WorkspaceFilter = Schema.NonEmptyString;
const ofNode = [
  Forbidden,
  SessionNotFound,
  SessionHasNoNode,
  NodeUnreachable,
  NodeNotFound,
  NodeRefused,
] as const;

export class AccountsGroup extends HttpApiGroup.make("accounts")
  .add(
    HttpApiEndpoint.get("current", "/account", { success: CurrentAccount, error: Forbidden }),
    HttpApiEndpoint.get("tokens", "/account/tokens", {
      success: Schema.Array(ApiToken),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("createOwnToken", "/account/tokens", {
      payload: NewApiToken,
      success: ApiTokenCreated.pipe(HttpApiSchema.status(201)),
      error: [Forbidden, SettingOutOfBounds],
    }),
    HttpApiEndpoint.delete("revokeToken", "/account/tokens/:id", {
      params: { id: Id },
      error: [Forbidden, ApiTokenNotFound],
    }),
    HttpApiEndpoint.get("list", "/accounts", {
      success: Schema.Array(ListedAccount),
      error: Forbidden,
    }),
    HttpApiEndpoint.get("lookup", "/accounts/lookup", {
      /** The whole address: a part of one finds nobody. */
      query: { email: Schema.NonEmptyString },
      success: AccountLookup,
      error: [Forbidden, PersonNotFound],
    }),
    HttpApiEndpoint.post("create", "/accounts", {
      payload: Schema.Struct({
        name: Schema.NonEmptyString,
        admin: Schema.optional(Schema.Boolean),
        kind: Schema.optional(Schema.Literals(["person", "service"])),
        /** For a person: the address they sign in with, once they set a password. */
        email: Schema.optional(Schema.NonEmptyString),
      }),
      success: Account.pipe(HttpApiSchema.status(201)),
      error: [Forbidden, EmailTaken, AccountInvalid],
    }),
    HttpApiEndpoint.get("get", "/accounts/:id", {
      params: { id: Id },
      success: ListedAccount,
      error: [Forbidden, AccountNotFound],
    }),
    HttpApiEndpoint.patch("change", "/accounts/:id", {
      params: { id: Id },
      /** What is said anew of the account; what is left out stays as it was. */
      payload: Schema.Struct({
        name: Schema.optional(Schema.NonEmptyString),
        admin: Schema.optional(Schema.Boolean),
      }),
      success: Account,
      error: [Forbidden, AccountNotFound, AccountInUse],
    }),
    HttpApiEndpoint.post("resetSecondFactor", "/accounts/:id/second-factor/reset", {
      params: { id: Id },
      error: [Forbidden, AccountNotFound, PersonNotFound],
    }),
    HttpApiEndpoint.post("disable", "/accounts/:id/disable", {
      params: { id: Id },
      success: Account,
      error: [Forbidden, AccountNotFound, AccountInUse],
    }),
    HttpApiEndpoint.post("enable", "/accounts/:id/enable", {
      params: { id: Id },
      success: Account,
      error: [Forbidden, AccountNotFound],
    }),
    HttpApiEndpoint.delete("remove", "/accounts/:id", {
      params: { id: Id },
      error: [Forbidden, AccountNotFound, AccountInUse],
    }),
    HttpApiEndpoint.post("removePasskeys", "/accounts/:id/passkeys/remove", {
      params: { id: Id },
      error: [Forbidden, AccountNotFound, PersonNotFound],
    }),
    HttpApiEndpoint.post("createSetupToken", "/accounts/:id/setup-token", {
      params: { id: Id },
      success: Schema.Struct({ token: Schema.String }).pipe(HttpApiSchema.status(201)),
      error: [Forbidden, AccountNotFound, PersonNotFound],
    }),
    HttpApiEndpoint.post("createToken", "/accounts/:id/tokens", {
      params: { id: Id },
      payload: NewApiToken,
      success: ApiTokenCreated.pipe(HttpApiSchema.status(201)),
      error: [Forbidden, AccountNotFound, SettingOutOfBounds],
    }),
    HttpApiEndpoint.get("tokensOf", "/accounts/:id/tokens", {
      params: { id: Id },
      success: Schema.Array(ApiToken),
      error: [Forbidden, AccountNotFound],
    }),
    HttpApiEndpoint.delete("revokeTokenOf", "/accounts/:id/tokens/:tokenId", {
      params: { id: Id, tokenId: Id },
      error: [Forbidden, AccountNotFound, ApiTokenNotFound],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Accounts",
      description:
        "Accounts and their API tokens. Only an admin makes them, changes what they are called and whether they are admins, disables them and removes them, and sees and takes back the tokens of an account that is not their own. Whoever says who is in a workspace finds a person's account by the whole of their email address.",
    }),
  ) {}

export class NodesGroup extends HttpApiGroup.make("nodes")
  .add(
    HttpApiEndpoint.get("list", "/nodes", { success: Schema.Array(Node), error: Forbidden }),
    HttpApiEndpoint.post("release", "/nodes/:id/release", {
      params: { id: Id },
      error: [Forbidden, NodeNotFound],
    }),
    HttpApiEndpoint.get("registrationTokens", "/registration-tokens", {
      success: Schema.Array(RegistrationToken),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("createRegistrationToken", "/registration-tokens", {
      payload: Schema.Struct({ name: Schema.NonEmptyString }),
      success: RegistrationTokenCreated.pipe(HttpApiSchema.status(201)),
      error: Forbidden,
    }),
    HttpApiEndpoint.delete("revokeRegistrationToken", "/registration-tokens/:id", {
      params: { id: Id },
      error: [Forbidden, RegistrationTokenNotFound],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Nodes",
      description:
        "The nodes that registered, and the tokens that let nodes register. A token that is revoked registers no new node, and the nodes that registered with it stay. A node keeps its name with the operator token it registered with: nothing else registers under the name, whatever registration token it has. Releasing a node lets its name go to the next that registers under it, for a node that was installed again.",
    }),
  ) {}

/**
 * What a session's browser keeps for the sites it visits, as its node takes it: the
 * session's own `storage-state` route says what each part holds.
 */
const StorageState = Schema.Struct({
  cookies: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  origins: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  tabs: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});

export class SessionsGroup extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.get("list", "/sessions", {
      /** Each narrows the list; together, a session has to be all of them. */
      query: {
        workspaceId: Schema.optional(WorkspaceFilter),
        state: Schema.optional(ObservedState),
        label: Schema.optional(Schema.NonEmptyString),
        tag: Schema.optional(TagFilter),
      },
      success: Schema.Array(Session),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/sessions", {
      payload: Schema.Struct({
        suspended: Schema.optional(Schema.Boolean),
        snapshotId: Schema.optional(Schema.NonEmptyString),
        label: Schema.optional(Schema.NonEmptyString),
        /** The workspace the session is of; the caller's own account's without. */
        workspaceId: Schema.optional(Schema.NonEmptyString),
        tags: Schema.optional(Tags),
        proxy: Schema.optional(ProxyConfig),
        /**
         * Cookies, the storage of origins and the tabs for the session's browser to start
         * with, over what its snapshot has: what a session's `storage-state` route gives,
         * and takes. Not for a session that is created suspended. The session is answered
         * with as soon as its browser runs, as `restoring`: it is `running` once all of
         * the state is in, and `failed`, with `failure` saying why, where its browser did
         * not take it.
         */
        storageState: Schema.optional(StorageState),
      }),
      success: Session.pipe(HttpApiSchema.status(201)),
      error: [Forbidden, WorkspaceNotFound, SnapshotNotFound, NoNode, NodeRefused, QuotaExceeded],
    }),
    HttpApiEndpoint.get("get", "/sessions/:id", {
      params: session,
      success: Session,
      error: [Forbidden, SessionNotFound],
    }),
    HttpApiEndpoint.patch("describe", "/sessions/:id", {
      params: session,
      payload: Schema.Struct({
        label: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
        tags: Schema.optional(Tags),
      }),
      success: Session,
      error: [Forbidden, SessionNotFound],
    }),
    HttpApiEndpoint.get("proxy", "/sessions/:id/proxy", {
      params: session,
      success: SessionProxy,
      error: [Forbidden, SessionNotFound],
    }),
    HttpApiEndpoint.put("setProxy", "/sessions/:id/proxy", {
      params: session,
      payload: SessionProxy,
      success: SessionProxy,
      error: ofNode,
    }),
    HttpApiEndpoint.post("suspend", "/sessions/:id/suspend", {
      params: session,
      success: Session,
      error: ofNode,
    }),
    HttpApiEndpoint.post("resume", "/sessions/:id/resume", {
      params: session,
      success: Session,
      error: [...ofNode, QuotaExceeded],
    }),
    HttpApiEndpoint.put("pin", "/sessions/:id/pin", {
      params: session,
      payload: Schema.Struct({ pinned: Schema.Boolean }),
      success: Session,
      error: [Forbidden, SessionNotFound, QuotaExceeded],
    }),
    HttpApiEndpoint.delete("delete", "/sessions/:id", { params: session, error: ofNode }),
    HttpApiEndpoint.post("createTicket", "/sessions/:id/tickets", {
      params: session,
      payload: Schema.Struct({
        name: Schema.optional(Schema.NonEmptyString),
        access: Schema.optional(Access),
      }),
      success: Admission.pipe(HttpApiSchema.status(201)),
      error: [Forbidden, SessionNotFound, SessionHasNoNode],
    }),
    HttpApiEndpoint.post("createFileLink", "/sessions/:id/file-links", {
      params: session,
      payload: Schema.Struct({
        path: SessionFilePath,
        /** A link a file is put at, in `uploads` alone; one it is read at, without. */
        write: Schema.optional(Schema.Boolean),
        /** Five minutes, without. */
        expiresInSeconds: Schema.optional(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: FILE_LINK_MOST })),
        ),
      }),
      success: FileLink.pipe(HttpApiSchema.status(201)),
      error: [Forbidden, SessionNotFound, SessionHasNoNode, FileLinkInvalid],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Sessions",
      description:
        "An account's sessions, wherever they run, the tickets into them, and links to their files. A ticket with no access watches, which a token that reads sessions asks for; a ticket that does more, and a link to a file, is for a token that writes them.",
    }),
  ) {}

export class SharesGroup extends HttpApiGroup.make("shares")
  .add(
    HttpApiEndpoint.get("list", "/sessions/:id/shares", {
      params: session,
      success: Schema.Array(Share),
      error: [Forbidden, SessionNotFound],
    }),
    HttpApiEndpoint.post("create", "/sessions/:id/shares", {
      params: session,
      payload: Schema.Struct({
        /** What whoever makes it knows it by; nothing, without. */
        name: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
        role: ShareRole,
        /**
         * The number of the one tab its guests are to see, and no other: the session's
         * whole, without. A tab that is closed shows them nothing.
         */
        tab: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        /** How many hours it is good for; for as long as it is not taken back, without. */
        expiresInHours: Schema.optional(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 87_600 })),
        ),
      }),
      success: ShareCreated.pipe(HttpApiSchema.status(201)),
      error: [Forbidden, SessionNotFound, SettingOutOfBounds],
    }),
    HttpApiEndpoint.delete("revoke", "/sessions/:id/shares/:shareId", {
      params: { ...session, shareId: Id },
      error: [Forbidden, SessionNotFound, ShareNotFound],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Share links",
      description:
        "Links that let someone with no account into one session, to watch it or to control it.",
    }),
  ) {}

export class SnapshotsGroup extends HttpApiGroup.make("snapshots")
  .add(
    HttpApiEndpoint.get("list", "/snapshots", {
      /** Each narrows the list; together, a snapshot has to be all of them. */
      query: {
        workspaceId: Schema.optional(WorkspaceFilter),
        name: Schema.optional(Schema.NonEmptyString),
        tag: Schema.optional(TagFilter),
      },
      success: Schema.Array(Snapshot),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("take", "/sessions/:id/snapshots", {
      params: session,
      payload: Schema.Struct({
        name: Schema.optional(Schema.NonEmptyString),
        description: Schema.optional(Schema.NonEmptyString),
        tags: Schema.optional(Tags),
        /**
         * A snapshot this one takes the place of: it is deleted once this is taken, and
         * what it was called, said to be and tagged with stays where nothing else is given.
         */
        replaces: Schema.optional(Schema.NonEmptyString),
      }),
      success: Snapshot.pipe(HttpApiSchema.status(201)),
      error: [...ofNode, SnapshotNotFound],
    }),
    HttpApiEndpoint.get("get", "/snapshots/:id", {
      params: { id: Schema.String },
      success: Snapshot,
      error: [Forbidden, SnapshotNotFound],
    }),
    HttpApiEndpoint.patch("describe", "/snapshots/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
        description: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
        tags: Schema.optional(Tags),
      }),
      success: Snapshot,
      error: [Forbidden, SnapshotNotFound],
    }),
    HttpApiEndpoint.delete("delete", "/snapshots/:id", {
      params: { id: Schema.String },
      error: [Forbidden, SnapshotNotFound, NodeUnreachable, NodeRefused],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Snapshots",
      description: "Snapshots of an account's sessions, and what sessions are created from.",
    }),
  ) {}

const workspace = { id: Id };

export class WorkspacesGroup extends HttpApiGroup.make("workspaces")
  .add(
    HttpApiEndpoint.get("list", "/workspaces", { success: Schema.Array(Workspace) }),
    HttpApiEndpoint.post("create", "/workspaces", {
      payload: Schema.Struct({ name: Schema.NonEmptyString }),
      success: Workspace.pipe(HttpApiSchema.status(201)),
      error: Forbidden,
    }),
    HttpApiEndpoint.patch("rename", "/workspaces/:id", {
      params: workspace,
      payload: Schema.Struct({ name: Schema.NonEmptyString }),
      success: Workspace,
      error: [WorkspaceNotFound, Forbidden],
    }),
    HttpApiEndpoint.delete("delete", "/workspaces/:id", {
      params: workspace,
      error: [WorkspaceNotFound, Forbidden, WorkspaceInUse],
    }),
    HttpApiEndpoint.get("members", "/workspaces/:id/members", {
      params: workspace,
      success: Schema.Array(WorkspaceMember),
      error: [WorkspaceNotFound, Forbidden],
    }),
    HttpApiEndpoint.put("admit", "/workspaces/:id/members/:accountId", {
      params: { ...workspace, accountId: Id },
      payload: Schema.Struct({ role: WorkspaceRole }),
      error: [WorkspaceNotFound, Forbidden, AccountNotFound],
    }),
    HttpApiEndpoint.delete("dismiss", "/workspaces/:id/members/:accountId", {
      params: { ...workspace, accountId: Id },
      error: [WorkspaceNotFound, Forbidden],
    }),
    HttpApiEndpoint.get("ofAccount", "/accounts/:accountId/workspaces", {
      params: { accountId: Id },
      success: Schema.Array(AccountWorkspace),
      error: [Forbidden, AccountNotFound],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Workspaces",
      description:
        "Where accounts keep sessions and snapshots together: what is a workspace's is all its members'. Any token is told the workspaces its account is in, of those it is held to where it is held to resources; who else is in one is for a token that reads workspaces. An admin of a workspace says who is in it, naming an account by its id; an admin is told which workspaces any account is in.",
    }),
  ) {}

export const EVENTS_MOST = 200;

export class EventsGroup extends HttpApiGroup.make("events")
  .add(
    HttpApiEndpoint.get("list", "/events", {
      query: {
        kind: Schema.optional(EventKind),
        /** An account's id, or a part of what the actor was called. */
        actor: Schema.optional(Schema.NonEmptyString),
        resourceKind: Schema.optional(EventResource.fields.kind),
        resourceId: Schema.optional(Schema.NonEmptyString),
        workspaceId: Schema.optional(Schema.NonEmptyString),
        /** Events from this moment on. */
        since: Schema.optional(Schema.DateTimeUtcFromString),
        /** Events before this moment. */
        until: Schema.optional(Schema.DateTimeUtcFromString),
        /** What a page before said the next is asked for with. */
        cursor: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{1,16}_[0-9a-f-]{36}$/u))),
        limit: Schema.optional(
          Schema.FiniteFromString.check(
            Schema.isInt(),
            Schema.isBetween({ minimum: 1, maximum: EVENTS_MOST }),
          ),
        ),
      },
      success: EventPage,
      error: Forbidden,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Events",
      description:
        "What was done by whom, the newest first. An admin reads all of it; anyone else what their own account did or had done to it, and what was done in the workspaces they are in.",
    }),
  ) {}

/** What an app asks a person for, as its authorization request says it. */
const asked = { clientId: Schema.NonEmptyString, redirectUri: Schema.NonEmptyString };

export class GrantsGroup extends HttpApiGroup.make("grants")
  .add(
    HttpApiEndpoint.get("asking", "/oauth/request", {
      query: asked,
      success: Schema.Struct({ clientId: Schema.String, clientName: Schema.String }),
      error: [OAuthClientNotFound, RedirectRefused],
    }),
    HttpApiEndpoint.get("list", "/oauth/grants", {
      success: Schema.Array(Grant),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("approve", "/oauth/grants", {
      payload: Schema.Struct({
        ...asked,
        /** What the app sent to know its own request by; it is sent back as it came. */
        state: Schema.optional(Schema.String),
        codeChallenge: Schema.NonEmptyString,
        /** What the app does: a grant is given for something, and does nothing else. */
        scopes: Schema.NonEmptyArray(Scope),
        /** The resources it is held to; all that the account reaches, without. */
        resources: Schema.optional(TokenResources),
      }),
      /** Where the person's browser goes with the answer: back to the app. */
      success: Schema.Struct({ redirectTo: Schema.String }).pipe(HttpApiSchema.status(201)),
      error: [Forbidden, OAuthClientNotFound, RedirectRefused],
    }),
    HttpApiEndpoint.delete("revoke", "/oauth/grants/:id", {
      params: { id: Id },
      error: [Forbidden, GrantNotFound],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Grants",
      description:
        "What people give apps that ask to act as their account over OAuth, as MCP clients do.",
    }),
  ) {}

export class ProvidersGroup extends HttpApiGroup.make("providers")
  .add(
    HttpApiEndpoint.get("list", "/sign-in-providers", {
      success: SignInProviders,
      error: Forbidden,
    }),
    HttpApiEndpoint.post("create", "/sign-in-providers", {
      payload: NewSignInProvider,
      success: SignInProvider.pipe(HttpApiSchema.status(201)),
      error: [Forbidden, ProviderTaken, ProviderInvalid],
    }),
    HttpApiEndpoint.post("check", "/sign-in-providers/check", {
      // An issuer, or where a provider without one is asked.
      payload: Schema.Struct({
        issuer: Schema.optional(Schema.String),
        endpoints: Schema.optional(GivenProviderEndpoints),
      }),
      success: ProviderChecked,
      error: Forbidden,
    }),
    HttpApiEndpoint.patch("change", "/sign-in-providers/:id", {
      params: { id: Schema.String },
      payload: ChangedSignInProvider,
      success: SignInProvider,
      error: [Forbidden, ProviderNotFound, ProviderConfigured, ProviderInvalid],
    }),
    HttpApiEndpoint.delete("remove", "/sign-in-providers/:id", {
      params: { id: Schema.String },
      error: [Forbidden, ProviderNotFound, ProviderConfigured],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Sign-in providers",
      description:
        "The providers people sign in through, which an admin adds, changes, disables and removes while the control plane runs. One speaks OpenID Connect and says at its issuer how it is reached, or OAuth 2.0 alone, as GitHub does, and is asked where it is said to be. Those the settings name are told beside them and changed there alone. A client secret is given and never told. Removing or disabling a provider removes nobody: whoever came through it alone does not sign in until it is back.",
    }),
  ) {}

export class SignInGroup extends HttpApiGroup.make("signIn")
  .add(HttpApiEndpoint.get("providers", "/sign-in/providers", { success: Schema.Array(Provider) }))
  .annotateMerge(
    OpenApi.annotations({
      title: "Signing in",
      description:
        "What whoever is not signed in yet is told: the providers people sign in through.",
    }),
  ) {}

/** Whether the first admin is still to be made: whether nobody signs in here yet. */
export const FirstAdminAwaited = Schema.Struct({ awaited: Schema.Boolean });

export class FirstAdminGroup extends HttpApiGroup.make("firstAdmin")
  .add(
    HttpApiEndpoint.get("awaited", "/first-admin", { success: FirstAdminAwaited }),
    HttpApiEndpoint.post("create", "/first-admin", {
      payload: Schema.Struct({
        /** What the link the control plane logged carries. */
        token: Schema.NonEmptyString,
        name: Schema.NonEmptyString,
        email: Schema.NonEmptyString,
        password: Schema.NonEmptyString,
      }),
      success: Account.pipe(HttpApiSchema.status(201)),
      error: [Forbidden, EmailTaken, AccountInvalid],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "First admin",
      description:
        "How the first person of a deployment is made, while there is none: with the token of the link the control plane logs when it starts, whoever opens the link names themselves and a password, and is an admin. Once anyone is a person here the token is good for nothing, and an admin makes the others.",
    }),
  ) {}

/** Whether this program serves: nothing of what it knows, and for anyone who asks. */
export const Health = Schema.Struct({ status: Schema.Literal("ok") });

export class HealthGroup extends HttpApiGroup.make("health")
  .add(HttpApiEndpoint.get("check", "/health", { success: Health }))
  .annotateMerge(
    OpenApi.annotations({
      title: "Health",
      description:
        "Whether the control plane serves, for what stands before it and what starts it: answered once its database is there, to anyone, and telling nothing.",
    }),
  ) {}

/** The control plane that answers. */
export const About = Schema.Struct({
  /** The version of Aperture it runs, as it is released: `1.0.0`, `0.0.0-nightly.<run>.<sha>`. */
  version: Schema.String,
  /**
   * The commit it was built from, in full, with `-dirty` after it for a tree that had
   * changes besides; nothing where whatever built it did not say. Between releases every
   * build has the last release's version, and this tells them apart.
   */
  commit: Schema.NullOr(Schema.String),
});

const refusedSetting = [Forbidden, WorkspaceNotFound, SessionNotFound, AccountNotFound] as const;
const changedSetting = [...refusedSetting, SettingInvalid, SettingOutOfBounds] as const;
const setting = { key: SettingKey };
/** The workspace the caller's settings are said in, as its member: none for what is their own. */
const inWorkspace = { workspaceId: Schema.optional(Schema.NonEmptyString) };
const person = { accountId: Id };
const member = { id: Id, accountId: Id };

export class SettingsGroup extends HttpApiGroup.make("settings")
  .add(
    HttpApiEndpoint.get("instance", "/settings", { success: SettingViews, error: refusedSetting }),
    HttpApiEndpoint.put("setInstance", "/settings/:key", {
      params: setting,
      payload: SettingEntry,
      success: SettingView,
      error: changedSetting,
    }),
    HttpApiEndpoint.delete("clearInstance", "/settings/:key", {
      params: setting,
      success: SettingView,
      error: refusedSetting,
    }),
    HttpApiEndpoint.get("workspace", "/workspaces/:id/settings", {
      params: { id: Id },
      success: SettingViews,
      error: refusedSetting,
    }),
    HttpApiEndpoint.put("setWorkspace", "/workspaces/:id/settings/:key", {
      params: { id: Id, ...setting },
      payload: SettingEntry,
      success: SettingView,
      error: changedSetting,
    }),
    HttpApiEndpoint.delete("clearWorkspace", "/workspaces/:id/settings/:key", {
      params: { id: Id, ...setting },
      success: SettingView,
      error: refusedSetting,
    }),
    HttpApiEndpoint.get("account", "/account/settings", {
      query: inWorkspace,
      success: SettingViews,
      error: refusedSetting,
    }),
    HttpApiEndpoint.put("setAccount", "/account/settings/:key", {
      params: setting,
      query: inWorkspace,
      payload: SettingEntry,
      success: SettingView,
      error: changedSetting,
    }),
    HttpApiEndpoint.delete("clearAccount", "/account/settings/:key", {
      params: setting,
      query: inWorkspace,
      success: SettingView,
      error: refusedSetting,
    }),
    HttpApiEndpoint.get("person", "/accounts/:accountId/settings", {
      params: person,
      success: SettingViews,
      error: refusedSetting,
    }),
    HttpApiEndpoint.put("setPerson", "/accounts/:accountId/settings/:key", {
      params: { ...person, ...setting },
      payload: SettingEntry,
      success: SettingView,
      error: changedSetting,
    }),
    HttpApiEndpoint.delete("clearPerson", "/accounts/:accountId/settings/:key", {
      params: { ...person, ...setting },
      success: SettingView,
      error: refusedSetting,
    }),
    HttpApiEndpoint.get("member", "/workspaces/:id/members/:accountId/settings", {
      params: member,
      success: SettingViews,
      error: refusedSetting,
    }),
    HttpApiEndpoint.put("setMember", "/workspaces/:id/members/:accountId/settings/:key", {
      params: { ...member, ...setting },
      payload: SettingEntry,
      success: SettingView,
      error: changedSetting,
    }),
    HttpApiEndpoint.delete("clearMember", "/workspaces/:id/members/:accountId/settings/:key", {
      params: { ...member, ...setting },
      success: SettingView,
      error: refusedSetting,
    }),
    HttpApiEndpoint.get("session", "/sessions/:id/settings", {
      params: session,
      success: SettingViews,
      error: refusedSetting,
    }),
    HttpApiEndpoint.put("setSession", "/sessions/:id/settings/:key", {
      params: { ...session, ...setting },
      payload: SettingEntry,
      success: SettingView,
      error: changedSetting,
    }),
    HttpApiEndpoint.delete("clearSession", "/sessions/:id/settings/:key", {
      params: { ...session, ...setting },
      success: SettingView,
      error: refusedSetting,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Settings",
      description:
        "What sessions are held to, said at five levels: the deployment, a workspace, a person (an account) wherever they are, a person as a member of one workspace, and a session. The nearest level that says a value is what a session has; a level also sets bounds, `min` and `max` or what is `allowed`, that it and the levels below it may not cross, and a bound of both ends alike is a lock. Each setting is told with what it comes to and where that comes from. The deployment's are an admin's to say and anyone's to read; a workspace's are its admins' to say and its members' to read. A person's are said at `/accounts/:accountId/settings` by an admin, and a member's at `/workspaces/:id/members/:accountId/settings` by an admin of the workspace or of the deployment; whoever says them reads them, and so does the person, at `/account/settings` (with `workspaceId` for what they have in a workspace). There the person says their own values, inside the bounds an admin set, which they neither change nor clear. A quota (sessions, running and pinned sessions, memory and processors) is held below the deployment to at most what the levels above make of it, and is no limit only under no limit: a person lowers their own, and raises it again no further than that, nor than a value an admin said of them. A session's are said by whoever made it or an admin of its workspace. Times are in seconds, and `null` is never or no limit.",
    }),
  ) {}

export class AboutGroup extends HttpApiGroup.make("about")
  .add(HttpApiEndpoint.get("get", "/about", { success: About }))
  .annotateMerge(
    OpenApi.annotations({
      title: "About",
      description:
        "The control plane itself: the version of Aperture it runs, and the commit it was built from.",
    }),
  ) {}

export class Api extends HttpApi.make("control")
  .add(
    AboutGroup,
    AccountsGroup,
    EventsGroup,
    GrantsGroup,
    NodesGroup,
    ProvidersGroup,
    SessionsGroup,
    SettingsGroup,
    SharesGroup,
    SnapshotsGroup,
    WorkspacesGroup,
  )
  .middleware(Authorization)
  // After the middleware, so that it has none: it is asked before anyone is signed in.
  .add(SignInGroup, FirstAdminGroup, HealthGroup)
  .prefix(PREFIX)
  .annotateMerge(
    OpenApi.annotations({
      title: "Aperture control plane",
      version: manifest.version,
      description:
        "Accounts, nodes, where sessions run, and tickets into them. A request carries an account's API token, or the access token an app was given over OAuth, as `Authorization: Bearer`.",
    }),
  ) {}
