import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type * as Api from "@aperture-browser/api-schema";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { Tenant, TenantsPage } from "../schemas.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

export interface TenantsListParams {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  deleted?: "active" | "deleted" | "all";
}

export type TenantsFilter = Omit<TenantsListParams, "cursor">;

/** Tenant administration. */
export class TenantsApi extends Context.Service<
  TenantsApi,
  {
    readonly listTenants: (
      credentials: ApiCredentials,
      params?: TenantsListParams,
    ) => Call<TenantsPage>;
    /** Every matching tenant, fetching pages as the stream is pulled. */
    readonly streamTenants: (
      credentials: ApiCredentials,
      filter?: TenantsFilter,
    ) => Stream.Stream<Tenant, ApiRequestError>;
    readonly listAllTenants: (
      credentials: ApiCredentials,
      filter?: TenantsFilter,
    ) => Call<ReadonlyArray<Tenant>>;
    readonly createTenant: (credentials: ApiCredentials, input: Api.TenantInput) => Call<Tenant>;
    readonly updateTenant: (
      credentials: ApiCredentials,
      tenantId: string,
      input: Api.TenantInput,
    ) => Call<Tenant>;
    readonly deleteTenant: (credentials: ApiCredentials, tenantId: string) => Call<Tenant>;
    readonly restoreTenant: (credentials: ApiCredentials, tenantId: string) => Call<Tenant>;
  }
>()("@aperture-browser/api-client/TenantsApi") {}
