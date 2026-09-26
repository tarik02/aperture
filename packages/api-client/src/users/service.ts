import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { PageCursor, PaginatedList } from "../pagination.ts";
import type { TenantMembership, User, UserInvitation } from "../schemas.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

export interface UsersFilter {
  limit?: number;
  query?: string;
  disabled?: "active" | "disabled" | "all";
}

export type UsersListParams = UsersFilter & PageCursor;

type UsersList = PaginatedList<UsersFilter, User>;

export interface UserInput {
  email: string | null;
  displayName: string;
  isSystemAdmin: boolean;
}

/** User administration and tenant memberships. */
export class UsersApi extends Context.Service<
  UsersApi,
  {
    readonly listUsers: UsersList["list"];
    readonly streamUsers: UsersList["stream"];
    readonly listAllUsers: UsersList["listAll"];
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
    readonly listTenantMemberships: (
      credentials: ApiCredentials,
      tenantId: string,
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
