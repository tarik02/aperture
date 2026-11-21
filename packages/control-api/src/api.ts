import * as Context from "effect/Context";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Schema from "effect/Schema";
import type { Caller } from "./caller.ts";
import {
  AccountInvalid,
  AccountNotFound,
  ApiTokenNotFound,
  EmailTaken,
  PersonNotFound,
  Forbidden,
  GrantNotFound,
  NodeRefused,
  NodeUnreachable,
  NoNode,
  OAuthClientNotFound,
  RedirectRefused,
  SessionHasNoNode,
  SessionNotFound,
  SnapshotNotFound,
  Unauthorized,
  WorkspaceInUse,
  WorkspaceNotFound,
} from "./errors.ts";
import {
  Access,
  DesiredState,
  ObservedState,
  Offers,
  ProxyConfig,
  Scope,
  TokenResources,
} from "./schemas.ts";

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
});

/** A workspace as its caller has it: `role` is none for an admin who is no member. */
export const Workspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  role: Schema.NullOr(WorkspaceRole),
});

export const WorkspaceMember = Schema.Struct({
  accountId: Schema.String,
  name: Schema.String,
  role: WorkspaceRole,
});

/** An API token as its account sees it: never the token. */
export const ApiToken = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** What it is held to; none for a token that does whatever its account does. */
  scopes: Schema.NullOr(Schema.Array(Scope)),
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
  accountId: Schema.String,
  workspaceId: Schema.NullOr(Schema.String),
  nodeId: Schema.NullOr(Schema.String),
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
});

export const Snapshot = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
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
});

export const Admission = Schema.Struct({
  ticket: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
  url: Schema.NullOr(Schema.String),
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

const session = { id: Schema.String };
/** What a session or a snapshot is found by: names, each with what it is set to. */
const Tags = Schema.Record(Schema.NonEmptyString, Schema.String);
/** A session's routing as it was last set through the control plane; none goes direct. */
const SessionProxy = Schema.Struct({ proxy: Schema.NullOr(ProxyConfig) });
const ofNode = [
  Forbidden,
  SessionNotFound,
  SessionHasNoNode,
  NodeUnreachable,
  NodeRefused,
] as const;

export class AccountsGroup extends HttpApiGroup.make("accounts")
  .add(
    HttpApiEndpoint.get("current", "/account", { success: Account, error: Forbidden }),
    HttpApiEndpoint.get("tokens", "/account/tokens", {
      success: Schema.Array(ApiToken),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("createOwnToken", "/account/tokens", {
      payload: NewApiToken,
      success: ApiTokenCreated.pipe(HttpApiSchema.status(201)),
      error: Forbidden,
    }),
    HttpApiEndpoint.delete("revokeToken", "/account/tokens/:id", {
      params: { id: Schema.String },
      error: [Forbidden, ApiTokenNotFound],
    }),
    HttpApiEndpoint.get("list", "/accounts", { success: Schema.Array(Account), error: Forbidden }),
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
    HttpApiEndpoint.post("resetSecondFactor", "/accounts/:id/second-factor/reset", {
      params: { id: Schema.String },
      error: [Forbidden, AccountNotFound, PersonNotFound],
    }),
    HttpApiEndpoint.post("createSetupToken", "/accounts/:id/setup-token", {
      params: { id: Schema.String },
      success: Schema.Struct({ token: Schema.String }).pipe(HttpApiSchema.status(201)),
      error: [Forbidden, AccountNotFound, PersonNotFound],
    }),
    HttpApiEndpoint.post("createToken", "/accounts/:id/tokens", {
      params: { id: Schema.String },
      payload: NewApiToken,
      success: ApiTokenCreated.pipe(HttpApiSchema.status(201)),
      error: [Forbidden, AccountNotFound],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Accounts",
      description: "Accounts and their API tokens. Only an admin makes them.",
    }),
  ) {}

export class NodesGroup extends HttpApiGroup.make("nodes")
  .add(
    HttpApiEndpoint.get("list", "/nodes", { success: Schema.Array(Node), error: Forbidden }),
    HttpApiEndpoint.get("registrationTokens", "/registration-tokens", {
      success: Schema.Array(RegistrationToken),
      error: Forbidden,
    }),
    HttpApiEndpoint.post("createRegistrationToken", "/registration-tokens", {
      payload: Schema.Struct({ name: Schema.NonEmptyString }),
      success: RegistrationTokenCreated.pipe(HttpApiSchema.status(201)),
      error: Forbidden,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Nodes",
      description: "The nodes that registered, and the tokens that let nodes register.",
    }),
  ) {}

export class SessionsGroup extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.get("list", "/sessions", {
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
      }),
      success: Session.pipe(HttpApiSchema.status(201)),
      error: [Forbidden, WorkspaceNotFound, SnapshotNotFound, NoNode, NodeRefused],
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
      error: ofNode,
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
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Sessions",
      description: "An account's sessions, wherever they run, and the tickets into them.",
    }),
  ) {}

export class SnapshotsGroup extends HttpApiGroup.make("snapshots")
  .add(
    HttpApiEndpoint.get("list", "/snapshots", {
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

const workspace = { id: Schema.String };

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
      error: WorkspaceNotFound,
    }),
    HttpApiEndpoint.put("admit", "/workspaces/:id/members/:accountId", {
      params: { ...workspace, accountId: Schema.String },
      payload: Schema.Struct({ role: WorkspaceRole }),
      error: [WorkspaceNotFound, Forbidden, AccountNotFound],
    }),
    HttpApiEndpoint.delete("dismiss", "/workspaces/:id/members/:accountId", {
      params: { ...workspace, accountId: Schema.String },
      error: [WorkspaceNotFound, Forbidden],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Workspaces",
      description:
        "Where accounts keep sessions and snapshots together: what is a workspace's is all its members'.",
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
      params: { id: Schema.String },
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

export class SignInGroup extends HttpApiGroup.make("signIn")
  .add(HttpApiEndpoint.get("providers", "/sign-in/providers", { success: Schema.Array(Provider) }))
  .annotateMerge(
    OpenApi.annotations({
      title: "Signing in",
      description:
        "What whoever is not signed in yet is told: the providers people sign in through.",
    }),
  ) {}

export class Api extends HttpApi.make("control")
  .add(AccountsGroup, GrantsGroup, NodesGroup, SessionsGroup, SnapshotsGroup, WorkspacesGroup)
  .middleware(Authorization)
  // After the middleware, so that it has none: it is asked before anyone is signed in.
  .add(SignInGroup)
  .prefix(PREFIX)
  .annotateMerge(
    OpenApi.annotations({
      title: "Aperture control plane",
      version: "0.0.0",
      description: "Accounts, nodes, where sessions run, and tickets into them.",
    }),
  ) {}
