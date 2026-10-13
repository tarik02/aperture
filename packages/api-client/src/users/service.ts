import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { PageCursor, PaginatedList } from "../pagination.ts";
import type { Tenant, TenantMembership, User, UserInvitation } from "../schemas.ts";

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

export interface CreateUserInput extends UserInput {
  /** `null` leaves the choice to the server's `auto_create_personal_tenant` default. */
  createPersonalTenant: boolean | null;
}

/** User administration and tenant memberships. */
export class UsersApi extends Context.Service<
  UsersApi,
  {
    readonly listUsers: UsersList["list"];
    readonly streamUsers: UsersList["stream"];
    readonly listAllUsers: UsersList["listAll"];
    readonly createUser: (credentials: ApiCredentials, input: CreateUserInput) => Call<User>;
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
    /** Creates the tenant owned by a user with every tenant scope. */
    readonly createPersonalTenant: (credentials: ApiCredentials, userId: string) => Call<Tenant>;
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
