import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Api from "@aperture/api-schema";
import { ApiAuthorization, Authorization, type ApiCredentials } from "../authorization/service.ts";
import { compactQuery } from "../query.ts";
import { UsersApi, type UserInput, type UsersListParams } from "./service.ts";

export const makeUsersApi = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const { authorize } = yield* ApiAuthorization;
  const api = Api.make(httpClient);

  const listUsers = Effect.fn("UsersApi.listUsers")(function* (
    credentials: ApiCredentials,
    params: UsersListParams = {},
  ) {
    return yield* api
      .listUsers({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          query: params.query,
          disabled: params.disabled,
        }),
      })
      .pipe(authorize(Authorization.of(credentials)));
  });

  const createUser = Effect.fn("UsersApi.createUser")(function* (
    credentials: ApiCredentials,
    input: UserInput,
  ) {
    return yield* api.createUser({ payload: input }).pipe(authorize(Authorization.of(credentials)));
  });

  const getUser = Effect.fn("UsersApi.getUser")(function* (
    credentials: ApiCredentials,
    userId: string,
  ) {
    return yield* api.getUser(userId, undefined).pipe(authorize(Authorization.of(credentials)));
  });

  const updateUser = Effect.fn("UsersApi.updateUser")(function* (
    credentials: ApiCredentials,
    userId: string,
    input: UserInput,
  ) {
    return yield* api
      .updateUser(userId, { payload: input })
      .pipe(authorize(Authorization.of(credentials)));
  });

  const createUserInvitation = Effect.fn("UsersApi.createUserInvitation")(function* (
    credentials: ApiCredentials,
    userId: string,
  ) {
    return yield* api
      .createUserInvitation(userId, undefined)
      .pipe(authorize(Authorization.of(credentials)));
  });

  const disableUser = Effect.fn("UsersApi.disableUser")(function* (
    credentials: ApiCredentials,
    userId: string,
  ) {
    return yield* api.disableUser(userId, undefined).pipe(authorize(Authorization.of(credentials)));
  });

  const restoreUser = Effect.fn("UsersApi.restoreUser")(function* (
    credentials: ApiCredentials,
    userId: string,
  ) {
    return yield* api.restoreUser(userId, undefined).pipe(authorize(Authorization.of(credentials)));
  });

  const listUserMemberships = Effect.fn("UsersApi.listUserMemberships")(function* (
    credentials: ApiCredentials,
    userId: string,
  ) {
    return yield* api
      .listUserMemberships(userId, undefined)
      .pipe(authorize(Authorization.of(credentials)));
  });

  const upsertTenantMembership = Effect.fn("UsersApi.upsertTenantMembership")(function* (
    credentials: ApiCredentials,
    tenantId: string,
    userId: string,
    scopes: readonly string[],
  ) {
    // Scopes arrive from free-form UI state; the server validates them.
    const payload = { scopes } as typeof Api.UpsertTenantMembershipRequestJson.Encoded;
    return yield* api
      .upsertTenantMembership(tenantId, userId, { payload })
      .pipe(authorize(Authorization.of(credentials)));
  });

  const deleteTenantMembership = Effect.fn("UsersApi.deleteTenantMembership")(function* (
    credentials: ApiCredentials,
    tenantId: string,
    userId: string,
  ) {
    yield* api
      .deleteTenantMembership(tenantId, userId, undefined)
      .pipe(authorize(Authorization.of(credentials)));
  });

  return UsersApi.of({
    listUsers,
    createUser,
    getUser,
    updateUser,
    createUserInvitation,
    disableUser,
    restoreUser,
    listUserMemberships,
    upsertTenantMembership,
    deleteTenantMembership,
  });
});

export const usersApiLayer = Layer.effect(UsersApi, makeUsersApi);
