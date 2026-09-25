import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Api from "@aperture-browser/api-schema";
import { ApiAuthorization, Authorization, type ApiCredentials } from "../authorization/service.ts";
import { paginate } from "../pagination.ts";
import { compactQuery } from "../query.ts";
import {
  TokensApi,
  type CreateAdminTokenInput,
  type CreateTenantTokenInput,
  type TokensFilter,
  type TokensListParams,
} from "./service.ts";

// Filters and scopes arrive from free-form UI state; the server validates them, so they
// are sent as the generated request types without narrowing.

export const makeTokensApi = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const { authorize } = yield* ApiAuthorization;
  const api = Api.make(httpClient);

  const listAdminTokens = Effect.fn("TokensApi.listAdminTokens")(function* (
    credentials: ApiCredentials,
    params: TokensListParams = {},
  ) {
    return yield* api
      .listAdminTokens({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          tenantId: params.tenantId,
          name: params.name,
          authorityType: params.authorityType,
          revoked: params.revoked,
          scope: params.scope,
        }) as typeof Api.ListAdminTokensParams.Encoded,
      })
      .pipe(authorize(Authorization.of(credentials)));
  });

  const streamAdminTokens = (credentials: ApiCredentials, filter: TokensFilter = {}) =>
    paginate(filter, (params) => listAdminTokens(credentials, params));

  const listAllAdminTokens = Effect.fn("TokensApi.listAllAdminTokens")(function* (
    credentials: ApiCredentials,
    filter: TokensFilter = {},
  ) {
    return yield* Stream.runCollect(streamAdminTokens(credentials, filter));
  });

  const createAdminToken = Effect.fn("TokensApi.createAdminToken")(function* (
    credentials: ApiCredentials,
    input: CreateAdminTokenInput,
  ) {
    const systemAdmin = input.authorityType === "system_admin";
    return yield* api
      .createAdminToken({
        payload: {
          name: input.name,
          authorityType: input.authorityType,
          tenantId: input.tenantId ?? null,
          scopes: input.scopes,
          resourceMode: systemAdmin ? "all" : input.resourceMode,
          resourceGrants: systemAdmin ? [] : input.resourceGrants,
          expiresAt: input.expiresAt ?? null,
        } as typeof Api.CreateAdminTokenRequestJson.Encoded,
      })
      .pipe(authorize(Authorization.of(credentials)));
  });

  const revokeAdminToken = Effect.fn("TokensApi.revokeAdminToken")(function* (
    credentials: ApiCredentials,
    tokenId: string,
  ) {
    yield* api.revokeAdminToken(tokenId, undefined).pipe(authorize(Authorization.of(credentials)));
  });

  const listTenantTokens = Effect.fn("TokensApi.listTenantTokens")(function* (
    credentials: ApiCredentials,
    params: TokensListParams = {},
  ) {
    return yield* api
      .listTenantTokens({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          name: params.name,
          revoked: params.revoked,
          scope: params.scope,
        }) as typeof Api.ListTenantTokensParams.Encoded,
      })
      .pipe(authorize(Authorization.of(credentials)));
  });

  const streamTenantTokens = (credentials: ApiCredentials, filter: TokensFilter = {}) =>
    paginate(filter, (params) => listTenantTokens(credentials, params));

  const listAllTenantTokens = Effect.fn("TokensApi.listAllTenantTokens")(function* (
    credentials: ApiCredentials,
    filter: TokensFilter = {},
  ) {
    return yield* Stream.runCollect(streamTenantTokens(credentials, filter));
  });

  const createTenantToken = Effect.fn("TokensApi.createTenantToken")(function* (
    credentials: ApiCredentials,
    input: CreateTenantTokenInput,
  ) {
    return yield* api
      .createTenantToken({
        payload: {
          name: input.name,
          scopes: input.scopes,
          resourceMode: input.resourceMode,
          resourceGrants: input.resourceGrants,
          expiresAt: input.expiresAt ?? null,
        } as typeof Api.CreateTenantTokenRequestJson.Encoded,
      })
      .pipe(authorize(Authorization.of(credentials)));
  });

  const revokeTenantToken = Effect.fn("TokensApi.revokeTenantToken")(function* (
    credentials: ApiCredentials,
    tokenId: string,
  ) {
    yield* api.revokeTenantToken(tokenId, undefined).pipe(authorize(Authorization.of(credentials)));
  });

  return TokensApi.of({
    listAdminTokens,
    streamAdminTokens,
    listAllAdminTokens,
    createAdminToken,
    revokeAdminToken,
    listTenantTokens,
    streamTenantTokens,
    listAllTenantTokens,
    createTenantToken,
    revokeTenantToken,
  });
});

export const tokensApiLayer = Layer.effect(TokensApi, makeTokensApi);
