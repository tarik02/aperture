import * as Schema from "effect/Schema";

/**
 * What a provider speaks: OpenID Connect, whose signed token says who someone is, or OAuth
 * 2.0 alone, where that is asked of the provider with the token it gave.
 */
export const Kind = Schema.Literals(["oidc", "oauth2"]);
export type Kind = typeof Kind.Type;

/**
 * Where a provider that speaks OAuth 2.0 alone is asked: where people are sent, where
 * what they come back with is exchanged for a token, and where the token tells who they
 * are. Where it lists their addresses apart, as GitHub does, the one that is theirs first
 * is taken from there, and is theirs only as that list says it is verified.
 */
export const Endpoints = Schema.Struct({
  authorization: Schema.String,
  token: Schema.String,
  userInfo: Schema.String,
  emails: Schema.NullOr(Schema.String),
});
export type Endpoints = typeof Endpoints.Type;

/**
 * A provider as it is kept: all an admin said of it, with its client secret sealed. The
 * secret leaves here opened for what signs people in, and is told to nobody.
 */
export const StoredProvider = Schema.Struct({
  /** What it is known by in addresses, and in what people who came through it keep. */
  id: Schema.String,
  name: Schema.String,
  /** Which provider's mark it is shown with, as whoever added it said; none said, without. */
  icon: Schema.NullOr(Schema.String),
  kind: Kind,
  /**
   * Its issuer, or its discovery document where that was given in place of it; nothing
   * for one that speaks OAuth 2.0 alone, which has `endpoints` in its place.
   */
  issuer: Schema.String,
  endpoints: Schema.NullOr(Endpoints),
  clientId: Schema.String,
  clientSecretSealed: Schema.String,
  scopes: Schema.Array(Schema.String),
  /** Whether someone it vouches for, whom no admin made a person, is made one. */
  provision: Schema.Boolean,
  /** The domains of the addresses people are made for so; any address where none is named. */
  domains: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromDate,
  updatedAt: Schema.DateTimeUtcFromDate,
});
export type StoredProvider = typeof StoredProvider.Type;

/** What is asked of a provider where nothing else is said. */
export const SCOPES = ["openid", "email", "profile"] as const;

/** What a provider's discovery document is found at, below its issuer. */
export const WELL_KNOWN = "/.well-known/openid-configuration";

/** Where a provider says how it is reached, whichever of the two addresses was given. */
export const discoveryOf = (issuer: string) =>
  issuer.endsWith(WELL_KNOWN) ? issuer : `${issuer.replace(/\/+$/u, "")}${WELL_KNOWN}`;
