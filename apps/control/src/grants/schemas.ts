import { Scope, TokenResources } from "@aperture-browser/control-api";
import * as Schema from "effect/Schema";

/** An app that asks people for a grant: an MCP client, as it registered itself. */
export const Client = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Where it may be sent what a person decided, and nowhere else. */
  redirectUris: Schema.Array(Schema.String),
  createdAt: Schema.DateTimeUtcFromDate,
});
export type Client = typeof Client.Type;

/**
 * What a person gave an app: to act as their account, held to scopes and resources as an
 * API token is. The app's tokens are good for as long as the grant is there.
 */
export const Grant = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  clientId: Schema.String,
  clientName: Schema.String,
  scopes: Schema.Array(Scope),
  /** The resources it is held to; none for a grant that reaches all its account does. */
  resources: Schema.NullOr(TokenResources),
  createdAt: Schema.DateTimeUtcFromDate,
});
export type Grant = typeof Grant.Type;

/** What an app is given for a grant: a token to call with, and one to get the next with. */
export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly scopes: ReadonlyArray<Scope>;
}
