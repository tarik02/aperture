import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Api from "@aperture-browser/api-schema";
import { ApiAuthorization, Authorization, type ApiCredentials } from "../authorization/service.ts";
import { compactQuery } from "../query.ts";
import { TenantsApi, type TenantsListParams } from "./service.ts";

export const makeTenantsApi = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const { authorize } = yield* ApiAuthorization;
  const api = Api.make(httpClient);

  const listTenants = Effect.fn("TenantsApi.listTenants")(function* (
    credentials: ApiCredentials,
    params: TenantsListParams = {},
  ) {
    return yield* api
      .listTenants({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          includeDeleted: params.includeDeleted || undefined,
          deleted: params.deleted,
        }),
      })
      .pipe(authorize(Authorization.of(credentials)));
  });

  const createTenant = Effect.fn("TenantsApi.createTenant")(function* (
    credentials: ApiCredentials,
    input: Api.TenantInput,
  ) {
    return yield* api
      .createTenant({ payload: input })
      .pipe(authorize(Authorization.of(credentials)));
  });

  const updateTenant = Effect.fn("TenantsApi.updateTenant")(function* (
    credentials: ApiCredentials,
    tenantId: string,
    input: Api.TenantInput,
  ) {
    return yield* api
      .updateTenant(tenantId, { payload: input })
      .pipe(authorize(Authorization.of(credentials)));
  });

  const deleteTenant = Effect.fn("TenantsApi.deleteTenant")(function* (
    credentials: ApiCredentials,
    tenantId: string,
  ) {
    return yield* api
      .deleteTenant(tenantId, undefined)
      .pipe(authorize(Authorization.of(credentials)));
  });

  const restoreTenant = Effect.fn("TenantsApi.restoreTenant")(function* (
    credentials: ApiCredentials,
    tenantId: string,
  ) {
    return yield* api
      .restoreTenant(tenantId, undefined)
      .pipe(authorize(Authorization.of(credentials)));
  });

  return TenantsApi.of({ listTenants, createTenant, updateTenant, deleteTenant, restoreTenant });
});

export const tenantsApiLayer = Layer.effect(TenantsApi, makeTenantsApi);
