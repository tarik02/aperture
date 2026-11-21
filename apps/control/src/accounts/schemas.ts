import { Scope, TokenResources } from "@aperture-browser/control-api";
import * as Schema from "effect/Schema";

/**
 * Who an account is for: a person, who signs in, or a service, which comes with API
 * tokens alone. Both hold sessions and snapshots, and both are let into workspaces.
 */
export const AccountKind = Schema.Literals(["person", "service"]);
export type AccountKind = typeof AccountKind.Type;

export const Account = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  admin: Schema.Boolean,
  kind: AccountKind,
  /** The address a person signs in with; none for a service. */
  email: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromDate,
});
export type Account = typeof Account.Type;

/** An API token as it is kept: what it is called and whose it is, and never the token. */
export const ApiToken = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromDate,
  /** When it stops being good by itself; never, without. */
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  /** When it was taken back; it is kept so that its account sees it was. */
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  /** What it is held to; none for a token that does whatever its account does. */
  scopes: Schema.NullOr(Schema.Array(Scope)),
  /** The resources it is held to; none for a token that reaches all its account does. */
  resources: Schema.NullOr(TokenResources),
});
export type ApiToken = typeof ApiToken.Type;
