import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { PageCursor, PaginatedList } from "../pagination.ts";
import type { ApiToken, CreateTokenResponse, ResourceGrant, ResourceMode } from "../schemas.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

export interface TokensFilter {
  limit?: number;
  tenantId?: string;
  name?: string;
  authorityType?: "system_admin" | "tenant";
  revoked?: "all" | "active" | "revoked";
  scope?: string;
}

export type TokensListParams = TokensFilter & PageCursor;

type TokensList = PaginatedList<TokensFilter, ApiToken>;

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
    readonly listAdminTokens: TokensList["list"];
    readonly streamAdminTokens: TokensList["stream"];
    readonly listAllAdminTokens: TokensList["listAll"];
    readonly createAdminToken: (
      credentials: ApiCredentials,
      input: CreateAdminTokenInput,
    ) => Call<CreateTokenResponse>;
    readonly revokeAdminToken: (credentials: ApiCredentials, tokenId: string) => Call<void>;
    readonly listTenantTokens: TokensList["list"];
    readonly streamTenantTokens: TokensList["stream"];
    readonly listAllTenantTokens: TokensList["listAll"];
    readonly createTenantToken: (
      credentials: ApiCredentials,
      input: CreateTenantTokenInput,
    ) => Call<CreateTokenResponse>;
    readonly revokeTenantToken: (credentials: ApiCredentials, tokenId: string) => Call<void>;
  }
>()("@aperture-browser/api-client/TokensApi") {}
