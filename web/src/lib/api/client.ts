import type { z } from "zod";
import { ApiRequestError, parseApiErrorBody } from "#/lib/api/errors.ts";
import {
  authMeSchema,
  healthSchema,
  sessionsPageSchema,
  snapshotsPageSchema,
  tenantsPageSchema,
  tokensPageSchema,
} from "#/lib/api/schemas.ts";
import type { AuthorityType, TokenProfile } from "#/stores/token-vault.ts";

export const TENANT_HEADER = "X-Aperture-Tenant-Id";

export type ApiCredentials = {
  token: string;
  authorityType: AuthorityType | null;
  tenantId: string | null;
  selectedTenantId: string | null;
};

export type TenantHeaderMode = "none" | "optional" | "tenant-scoped";

export function credentialsFromProfile(profile: TokenProfile): ApiCredentials {
  return {
    token: profile.rawToken,
    authorityType: profile.authorityType,
    tenantId: profile.tenantId,
    selectedTenantId: profile.selectedTenantId,
  };
}

export function resolveTenantHeader(
  credentials: ApiCredentials,
  mode: TenantHeaderMode,
): string | undefined {
  if (mode === "none") {
    return undefined;
  }

  if (mode === "optional") {
    return credentials.selectedTenantId ?? undefined;
  }

  if (credentials.authorityType === "tenant") {
    return credentials.tenantId ?? undefined;
  }

  if (credentials.authorityType === "system_admin") {
    return credentials.selectedTenantId ?? undefined;
  }

  return undefined;
}

type RequestOptions<T extends z.ZodType> = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  schema: T;
  credentials?: ApiCredentials | null;
  tenantHeader?: TenantHeaderMode;
  query?: Record<string, string | number | boolean | undefined | null>;
};

async function request<T extends z.ZodType>(options: RequestOptions<T>): Promise<z.infer<T>> {
  const {
    method = "GET",
    path,
    schema,
    credentials = null,
    tenantHeader = "none",
    query,
  } = options;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (credentials?.token) {
    headers.Authorization = `Bearer ${credentials.token.trim()}`;
  }

  const tenantId = credentials ? resolveTenantHeader(credentials, tenantHeader) : undefined;
  if (tenantId) {
    headers[TENANT_HEADER] = tenantId;
  }

  let url = path;
  if (query) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      search.set(key, String(value));
    }
    const queryString = search.toString();
    if (queryString) {
      url = `${path}?${queryString}`;
    }
  }

  const response = await fetch(url, { method, headers });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = parseApiErrorBody(body);
    if (parsed) {
      throw new ApiRequestError(parsed.code, parsed.message, response.status);
    }
    throw new ApiRequestError("internal_error", "Request failed", response.status);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiRequestError("internal_error", "Invalid response", response.status);
  }

  return parsed.data;
}

export type SessionsListParams = {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  status?: string;
  tagKey?: string;
  tagValue?: string;
};

export type SnapshotsListParams = {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  tagKey?: string;
  tagValue?: string;
};

export type TenantsListParams = {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
};

export type TokensListParams = {
  limit?: number;
  cursor?: string;
  tenantId?: string;
};

export const apiClient = {
  getHealth() {
    return request({
      path: "/api/health",
      schema: healthSchema,
    });
  },

  getAuthMe(credentials: ApiCredentials) {
    return request({
      path: "/api/auth/me",
      schema: authMeSchema,
      credentials,
      tenantHeader: "optional",
    });
  },

  listTenants(credentials: ApiCredentials, params: TenantsListParams = {}) {
    return request({
      path: "/api/admin/tenants",
      schema: tenantsPageSchema,
      credentials,
      query: {
        limit: params.limit,
        cursor: params.cursor,
        includeDeleted: params.includeDeleted ? "true" : undefined,
      },
    });
  },

  listSessions(credentials: ApiCredentials, params: SessionsListParams = {}) {
    return request({
      path: "/api/sessions",
      schema: sessionsPageSchema,
      credentials,
      tenantHeader: "tenant-scoped",
      query: {
        limit: params.limit,
        cursor: params.cursor,
        includeDeleted: params.includeDeleted ? "true" : undefined,
        status: params.status,
        tagKey: params.tagKey,
        tagValue: params.tagValue,
      },
    });
  },

  listSnapshots(credentials: ApiCredentials, params: SnapshotsListParams = {}) {
    return request({
      path: "/api/snapshots",
      schema: snapshotsPageSchema,
      credentials,
      tenantHeader: "tenant-scoped",
      query: {
        limit: params.limit,
        cursor: params.cursor,
        includeDeleted: params.includeDeleted ? "true" : undefined,
        tagKey: params.tagKey,
        tagValue: params.tagValue,
      },
    });
  },

  listAdminTokens(credentials: ApiCredentials, params: TokensListParams = {}) {
    return request({
      path: "/api/admin/tokens",
      schema: tokensPageSchema,
      credentials,
      query: {
        limit: params.limit,
        cursor: params.cursor,
        tenantId: params.tenantId,
      },
    });
  },

  listTenantTokens(credentials: ApiCredentials, params: TokensListParams = {}) {
    return request({
      path: "/api/tenant/tokens",
      schema: tokensPageSchema,
      credentials,
      query: {
        limit: params.limit,
        cursor: params.cursor,
      },
    });
  },
};
