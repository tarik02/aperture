import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { TenantMembership, User, UserInvitation, UsersPage } from "../schemas.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

export interface UsersListParams {
  limit?: number;
  cursor?: string;
  query?: string;
  disabled?: "active" | "disabled" | "all";
}

export type UsersFilter = Omit<UsersListParams, "cursor">;

export interface UserInput {
  email: string | null;
  displayName: string;
  isSystemAdmin: boolean;
}

/** User administration and tenant memberships. */
export class UsersApi extends Context.Service<
  UsersApi,
  {
    readonly listUsers: (credentials: ApiCredentials, params?: UsersListParams) => Call<UsersPage>;
    /** Every matching user, fetching pages as the stream is pulled. */
    readonly streamUsers: (
      credentials: ApiCredentials,
      filter?: UsersFilter,
    ) => Stream.Stream<User, ApiRequestError>;
    readonly listAllUsers: (
      credentials: ApiCredentials,
      filter?: UsersFilter,
    ) => Call<ReadonlyArray<User>>;
    readonly createUser: (credentials: ApiCredentials, input: UserInput) => Call<User>;
    readonly getUser: (credentials: ApiCredentials, userId: string) => Call<User>;
    readonly updateUser: (
      credentials: ApiCredentials,
      userId: string,
      input: UserInput,
    ) => Call<User>;
    readonly createUserInvitation: (
      credentials: ApiCredentials,
      userId: string,
    ) => Call<UserInvitation>;
    readonly disableUser: (credentials: ApiCredentials, userId: string) => Call<User>;
    readonly restoreUser: (credentials: ApiCredentials, userId: string) => Call<User>;
    readonly listUserMemberships: (
      credentials: ApiCredentials,
      userId: string,
    ) => Call<ReadonlyArray<TenantMembership>>;
    readonly upsertTenantMembership: (
      credentials: ApiCredentials,
      tenantId: string,
      userId: string,
      scopes: readonly string[],
    ) => Call<TenantMembership>;
    readonly deleteTenantMembership: (
      credentials: ApiCredentials,
      tenantId: string,
      userId: string,
    ) => Call<void>;
  }
>()("@aperture-browser/api-client/UsersApi") {}
