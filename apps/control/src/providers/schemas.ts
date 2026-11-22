import * as Schema from "effect/Schema";

/**
 * A provider as it is kept: all an admin said of it, with its client secret sealed. The
 * secret leaves here opened for what signs people in, and is told to nobody.
 */
export const StoredProvider = Schema.Struct({
  /** What it is known by in addresses, and in what people who came through it keep. */
  id: Schema.String,
  name: Schema.String,
  /** Its issuer, or its discovery document where that was given in place of it. */
  issuer: Schema.String,
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
