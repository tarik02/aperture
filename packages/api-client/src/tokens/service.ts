import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type {
  ApiToken,
  CreateTokenResponse,
  ResourceGrant,
  ResourceMode,
  TokensPage,
} from "../schemas.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

export interface TokensListParams {
  limit?: number;
  cursor?: string;
  tenantId?: string;
  name?: string;
  authorityType?: "system_admin" | "tenant";
  revoked?: "all" | "active" | "revoked";
  scope?: string;
}

export type TokensFilter = Omit<TokensListParams, "cursor">;

export interface CreateAdminTokenInput {
  name: string;
  authorityType: "system_admin" | "tenant";
  tenantId?: string | null;
  scopes: string[];
  resourceMode: ResourceMode;
  resourceGrants: ResourceGrant[];
  expiresAt?: string | null;
}

export interface CreateTenantTokenInput {
  name: string;
  scopes: string[];
  resourceMode: ResourceMode;
  resourceGrants: ResourceGrant[];
  expiresAt?: string | null;
}

/** API tokens, issued either deployment-wide or within the current tenant. */
export class TokensApi extends Context.Service<
  TokensApi,
  {
    readonly listAdminTokens: (
      credentials: ApiCredentials,
      params?: TokensListParams,
    ) => Call<TokensPage>;
    /** Every matching deployment-wide token, fetching pages as the stream is pulled. */
    readonly streamAdminTokens: (
      credentials: ApiCredentials,
      filter?: TokensFilter,
    ) => Stream.Stream<ApiToken, ApiRequestError>;
    readonly listAllAdminTokens: (
      credentials: ApiCredentials,
      filter?: TokensFilter,
    ) => Call<ReadonlyArray<ApiToken>>;
    readonly createAdminToken: (
      credentials: ApiCredentials,
      input: CreateAdminTokenInput,
    ) => Call<CreateTokenResponse>;
    readonly revokeAdminToken: (credentials: ApiCredentials, tokenId: string) => Call<void>;
    readonly listTenantTokens: (
      credentials: ApiCredentials,
      params?: TokensListParams,
    ) => Call<TokensPage>;
    /** Every matching token of the current tenant, fetching pages as the stream is pulled. */
    readonly streamTenantTokens: (
      credentials: ApiCredentials,
      filter?: TokensFilter,
    ) => Stream.Stream<ApiToken, ApiRequestError>;
    readonly listAllTenantTokens: (
      credentials: ApiCredentials,
      filter?: TokensFilter,
    ) => Call<ReadonlyArray<ApiToken>>;
    readonly createTenantToken: (
      credentials: ApiCredentials,
      input: CreateTenantTokenInput,
    ) => Call<CreateTokenResponse>;
    readonly revokeTenantToken: (credentials: ApiCredentials, tokenId: string) => Call<void>;
  }
>()("@aperture-browser/api-client/TokensApi") {}
