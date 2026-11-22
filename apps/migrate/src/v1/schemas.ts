import * as Schema from "effect/Schema";

/** The last migration of v1's database, which is the one whose tables these are. */
export const SCHEMA_VERSION = 23;

/** v1 writes a moment as RFC 3339 text. */
const Moment = Schema.DateFromString;
const Scopes = Schema.fromJsonString(Schema.Array(Schema.String));

export const Tenant = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  createdAt: Moment,
  deletedAt: Schema.NullOr(Moment),
  /** The user a personal tenant is of; none for a tenant its members share. */
  ownerUserId: Schema.NullOr(Schema.String),
});
export type Tenant = typeof Tenant.Type;

export const User = Schema.Struct({
  id: Schema.String,
  email: Schema.NullOr(Schema.String),
  displayName: Schema.String,
  isSystemAdmin: Schema.BooleanFromBit,
  createdAt: Moment,
  disabledAt: Schema.NullOr(Moment),
});
export type User = typeof User.Type;

export const Membership = Schema.Struct({
  tenantId: Schema.String,
  userId: Schema.String,
  scopes: Scopes,
  createdAt: Moment,
});
export type Membership = typeof Membership.Type;

export const ApiToken = Schema.Struct({
  id: Schema.String,
  authorityType: Schema.Literals(["system_admin", "tenant"]),
  tenantId: Schema.NullOr(Schema.String),
  name: Schema.String,
  scopes: Scopes,
  createdAt: Moment,
  createdByType: Schema.Literals(["api_token", "user", "system"]),
  createdById: Schema.NullOr(Schema.String),
  resourceMode: Schema.Literals(["all", "allowlist"]),
  expiresAt: Schema.NullOr(Moment),
  revokedAt: Schema.NullOr(Moment),
});
export type ApiToken = typeof ApiToken.Type;

/** One session or snapshot a token with an allowlist reaches. */
export const ResourceGrant = Schema.Struct({
  tokenId: Schema.String,
  resourceType: Schema.Literals(["session", "snapshot"]),
  resourceId: Schema.String,
});
export type ResourceGrant = typeof ResourceGrant.Type;

export const Snapshot = Schema.Struct({
  id: Schema.String,
  tenantId: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  promotedFromSessionId: Schema.NullOr(Schema.String),
  createdAt: Moment,
  deletedAt: Schema.NullOr(Moment),
});
export type Snapshot = typeof Snapshot.Type;

export const Session = Schema.Struct({
  id: Schema.String,
  tenantId: Schema.String,
  /** The snapshot its profile stands on; none for one that began with an empty profile. */
  baseSnapshotId: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  status: Schema.Literals(["creating", "running", "suspended", "deleted", "expired", "failed"]),
  createdAt: Moment,
  /** When v1 removed what it kept of it; never, for one whose profile and files are there. */
  expiredAt: Schema.NullOr(Moment),
  /** Its routing as v1 kept it, as JSON; none for one whose connections all went direct. */
  proxyConfig: Schema.NullOr(Schema.String),
});
export type Session = typeof Session.Type;

/** What v1 keeps of a session on disk, beside its row. */
export interface SessionOnDisk {
  /** What its browser wrote above its snapshot; none where the directory is not there. */
  readonly upper: string | null;
  /** Its files; none where it has none. */
  readonly files: string | null;
  /** Whether its profile is still mounted, as it is while its browser runs. */
  readonly mounted: boolean;
}

/** v1's routing of a session, of which this program reads what v2 has a place for. */
export const Routing = Schema.fromJsonString(
  Schema.Struct({
    upstreams: Schema.optional(
      Schema.Record(
        Schema.String,
        Schema.Struct({ url: Schema.String, auth: Schema.optional(Schema.String) }),
      ),
    ),
    rules: Schema.optional(
      Schema.Array(Schema.Struct({ match: Schema.String, via: Schema.String })),
    ),
  }),
);

/** What tells one installation of v1 from another, made when it was. */
export const Install = Schema.Struct({
  installId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/iu)),
  createdAt: Moment,
});
export type Install = typeof Install.Type;

/** A tag of a session or a snapshot, by the id of what it is on. */
export const Tag = Schema.Struct({ of: Schema.String, key: Schema.String, value: Schema.String });
export type Tag = typeof Tag.Type;

export const Count = Schema.Struct({ count: Schema.Number });

/** The tables whose rows go nowhere in v2, each with why. */
export const WITHOUT_A_HOME = {
  user_passwords:
    "v1 keeps passwords as Argon2id and v2 signs people in by another: each person sets a new one with a setup link",
  totp_credentials: "a second factor is turned on again by the person it is of",
  recovery_codes: "they go with the second factor they were of",
  passkeys: "a passkey is added again by the person it is of",
  oidc_identities:
    "a provider signs in whoever has the address it verified, so nothing is kept of it",
  user_invitations: "an admin makes setup links in v2",
  web_sessions: "everyone signs in again",
  oauth_clients: "an app registers itself with v2 when it first asks",
  oauth_grants: "an app is given its grant again by the person",
  oauth_tokens: "they end with their grants",
  session_tokens: "v2 lets into a session by tickets and share links",
  session_collaboration_capabilities: "whoever has a session makes share links for it in v2",
  events: "v1's event log stays in v1's database",
  audit_events: "v1's audit log stays in v1's database",
} as const;
export type WithoutAHome = keyof typeof WITHOUT_A_HOME;

/** All of v1 that this program reads, as it was when it was read. */
export interface V1Data {
  readonly tenants: ReadonlyArray<Tenant>;
  readonly users: ReadonlyArray<User>;
  readonly memberships: ReadonlyArray<Membership>;
  readonly tokens: ReadonlyArray<ApiToken>;
  readonly grants: ReadonlyArray<ResourceGrant>;
  /** Each with where its profile is; none where the directory is not there. */
  readonly snapshots: ReadonlyArray<Snapshot & { readonly profile: string | null }>;
  readonly snapshotTags: ReadonlyArray<Tag>;
  readonly sessions: ReadonlyArray<Session & SessionOnDisk>;
  readonly sessionTags: ReadonlyArray<Tag>;
  readonly install: Install;
  /** How many rows each table that goes nowhere has. */
  readonly withoutAHome: Readonly<Record<WithoutAHome, number>>;
}
