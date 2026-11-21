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
  AccountNotFound,
  ApiTokenNotFound,
  Forbidden,
  NodeRefused,
  NodeUnreachable,
  NoNode,
  SessionHasNoNode,
  SessionNotFound,
  SnapshotNotFound,
  Unauthorized,
} from "./errors.ts";
import { Access, DesiredState, ObservedState, Offers, ProxyConfig } from "./schemas.ts";

/** Where the control plane's API is, apart from the routes of sessions and of nodes. */
export const PREFIX = "/api/control";

export const Account = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  admin: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
});

/** An API token as its account sees it: never the token. */
export const ApiToken = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

/** A token as it is told once, when it is made. */
export const ApiTokenCreated = Schema.Struct({ ...ApiToken.fields, token: Schema.String });

const NewApiToken = Schema.Struct({
  name: Schema.NonEmptyString,
  /** How many days it is good for; for as long as it is not taken back, without. */
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
  name: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  nodeId: Schema.NullOr(Schema.String),
  shared: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
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
const ofNode = [SessionNotFound, SessionHasNoNode, NodeUnreachable, NodeRefused] as const;

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
      error: ApiTokenNotFound,
    }),
    HttpApiEndpoint.get("list", "/accounts", { success: Schema.Array(Account), error: Forbidden }),
    HttpApiEndpoint.post("create", "/accounts", {
      payload: Schema.Struct({
        name: Schema.NonEmptyString,
        admin: Schema.optional(Schema.Boolean),
      }),
      success: Account.pipe(HttpApiSchema.status(201)),
      error: Forbidden,
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
    HttpApiEndpoint.get("list", "/sessions", { success: Schema.Array(Session) }),
    HttpApiEndpoint.post("create", "/sessions", {
      payload: Schema.Struct({
        suspended: Schema.optional(Schema.Boolean),
        snapshotId: Schema.optional(Schema.NonEmptyString),
        label: Schema.optional(Schema.NonEmptyString),
        tags: Schema.optional(Tags),
        proxy: Schema.optional(ProxyConfig),
      }),
      success: Session.pipe(HttpApiSchema.status(201)),
      error: [Forbidden, SnapshotNotFound, NoNode, NodeRefused],
    }),
    HttpApiEndpoint.get("get", "/sessions/:id", {
      params: session,
      success: Session,
      error: SessionNotFound,
    }),
    HttpApiEndpoint.patch("describe", "/sessions/:id", {
      params: session,
      payload: Schema.Struct({
        label: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
        tags: Schema.optional(Tags),
      }),
      success: Session,
      error: SessionNotFound,
    }),
    HttpApiEndpoint.get("proxy", "/sessions/:id/proxy", {
      params: session,
      success: SessionProxy,
      error: SessionNotFound,
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
    HttpApiEndpoint.get("list", "/snapshots", { success: Schema.Array(Snapshot) }),
    HttpApiEndpoint.post("take", "/sessions/:id/snapshots", {
      params: session,
      payload: Schema.Struct({
        name: Schema.optional(Schema.NonEmptyString),
        description: Schema.optional(Schema.NonEmptyString),
        tags: Schema.optional(Tags),
      }),
      success: Snapshot.pipe(HttpApiSchema.status(201)),
      error: ofNode,
    }),
    HttpApiEndpoint.get("get", "/snapshots/:id", {
      params: { id: Schema.String },
      success: Snapshot,
      error: SnapshotNotFound,
    }),
    HttpApiEndpoint.patch("describe", "/snapshots/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
        description: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
        tags: Schema.optional(Tags),
      }),
      success: Snapshot,
      error: SnapshotNotFound,
    }),
    HttpApiEndpoint.delete("delete", "/snapshots/:id", {
      params: { id: Schema.String },
      error: [SnapshotNotFound, NodeUnreachable, NodeRefused],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Snapshots",
      description: "Snapshots of an account's sessions, and what sessions are created from.",
    }),
  ) {}

export class Api extends HttpApi.make("control")
  .add(AccountsGroup, NodesGroup, SessionsGroup, SnapshotsGroup)
  .middleware(Authorization)
  .prefix(PREFIX)
  .annotateMerge(
    OpenApi.annotations({
      title: "Aperture control plane",
      version: "0.0.0",
      description: "Accounts, nodes, where sessions run, and tickets into them.",
    }),
  ) {}
