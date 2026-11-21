import * as Schema from "effect/Schema";

export const Account = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  admin: Schema.Boolean,
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
});
export type ApiToken = typeof ApiToken.Type;
