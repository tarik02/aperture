export { ApiRequestError, apiErrorSchema, parseApiErrorBody } from "#/lib/api/errors.ts";
export type { ApiErrorBody } from "#/lib/api/errors.ts";

export {
  apiClient,
  credentialsFromProfile,
  resolveTenantHeader,
  TENANT_HEADER,
} from "#/lib/api/client.ts";
export type {
  ApiCredentials,
  SessionsListParams,
  SnapshotsListParams,
  TenantsListParams,
  TenantHeaderMode,
  TokensListParams,
} from "#/lib/api/client.ts";

export {
  appendQueryParams,
  defaultListLimit,
  flattenInfinitePages,
  getNextPageParam,
  listQueryDefaults,
} from "#/lib/api/pagination.ts";
export type { ListQueryParams, PaginatedResponse } from "#/lib/api/pagination.ts";

export {
  authMeSchema,
  healthSchema,
  pageMetaSchema,
  paginatedSchema,
  principalSchema,
  sessionSchema,
  sessionStatusSchema,
  sessionsPageSchema,
  snapshotSchema,
  snapshotsPageSchema,
  tenantSchema,
  tokenSchema,
  tokensPageSchema,
  tenantsPageSchema,
} from "#/lib/api/schemas.ts";
export type {
  ApiToken,
  AuthMePrincipal,
  AuthMeResponse,
  AuthMeTenant,
  PageMeta,
  Session,
  SessionStatus,
  SessionsPage,
  Snapshot,
  SnapshotsPage,
  Tenant,
  TenantsPage,
  TokensPage,
} from "#/lib/api/schemas.ts";
