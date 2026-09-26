import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Api from "@aperture-browser/api-schema";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { PageCursor, PaginatedList } from "../pagination.ts";
import type { Tenant } from "../schemas.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

export interface TenantsFilter {
  limit?: number;
  includeDeleted?: boolean;
  deleted?: "active" | "deleted" | "all";
}

export type TenantsListParams = TenantsFilter & PageCursor;

type TenantsList = PaginatedList<TenantsFilter, Tenant>;

/** Tenant administration, and the tenant a tenant token belongs to. */
export class TenantsApi extends Context.Service<
  TenantsApi,
  {
    readonly listTenants: TenantsList["list"];
    readonly streamTenants: TenantsList["stream"];
    readonly listAllTenants: TenantsList["listAll"];
    readonly createTenant: (credentials: ApiCredentials, input: Api.TenantInput) => Call<Tenant>;
    readonly updateTenant: (
      credentials: ApiCredentials,
      tenantId: string,
      input: Api.TenantInput,
    ) => Call<Tenant>;
    readonly deleteTenant: (credentials: ApiCredentials, tenantId: string) => Call<Tenant>;
    readonly restoreTenant: (credentials: ApiCredentials, tenantId: string) => Call<Tenant>;
    /** The tenant of a tenant token. */
    readonly getCurrentTenant: (credentials: ApiCredentials) => Call<Tenant>;
    readonly updateCurrentTenant: (
      credentials: ApiCredentials,
      input: Api.TenantInput,
    ) => Call<Tenant>;
  }
>()("@aperture-browser/api-client/TenantsApi") {}
