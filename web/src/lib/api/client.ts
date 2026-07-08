import type { z } from "zod";
import { ApiRequestError, parseApiErrorBody } from "#/lib/api/errors.ts";
import type { TagFilterValue } from "#/lib/tag-filter.ts";
import {
  authMeSchema,
  browserChannelsSchema,
  createSessionResponseSchema,
  createTokenResponseSchema,
  eventsPageSchema,
  healthSchema,
  promoteSessionResponseSchema,
  screencastStatusSchema,
  sessionMutationResponseSchema,
  sessionsPageSchema,
  snapshotMutationResponseSchema,
  snapshotsPageSchema,
  tenantSchema,
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

type QueryValue = string | number | boolean | Array<string | number | boolean> | undefined | null;

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
  query?: Record<string, QueryValue>;
  body?: unknown;
};

type VoidRequestOptions = Omit<RequestOptions<z.ZodType>, "schema">;

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) {
    return path;
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== "") {
          search.append(key, String(item));
        }
      }
      continue;
    }
    search.set(key, String(value));
  }

  const queryString = search.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function buildHeaders(
  credentials: ApiCredentials | null | undefined,
  tenantHeader: TenantHeaderMode,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }

  if (credentials?.token) {
    headers.Authorization = `Bearer ${credentials.token.trim()}`;
  }

  const tenantId = credentials ? resolveTenantHeader(credentials, tenantHeader) : undefined;
  if (tenantId) {
    headers[TENANT_HEADER] = tenantId;
  }

  return headers;
}

async function request<T extends z.ZodType>(options: RequestOptions<T>): Promise<z.infer<T>> {
  const {
    method = "GET",
    path,
    schema,
    credentials = null,
    tenantHeader = "none",
    query,
    body,
  } = options;

  const hasBody = body !== undefined;
  const response = await fetch(buildUrl(path, query), {
    method,
    headers: buildHeaders(credentials, tenantHeader, hasBody),
    body: hasBody ? JSON.stringify(body) : undefined,
  });

  const responseBody: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = parseApiErrorBody(responseBody);
    if (parsed) {
      throw new ApiRequestError(parsed.code, parsed.message, response.status);
    }
    throw new ApiRequestError("internal_error", "Request failed", response.status);
  }

  const parsed = schema.safeParse(responseBody);
  if (!parsed.success) {
    throw new ApiRequestError("internal_error", "Invalid response", response.status);
  }

  return parsed.data;
}

async function requestVoid(options: VoidRequestOptions): Promise<void> {
  const { method = "GET", path, credentials = null, tenantHeader = "none", query, body } = options;

  const hasBody = body !== undefined;
  const response = await fetch(buildUrl(path, query), {
    method,
    headers: buildHeaders(credentials, tenantHeader, hasBody),
    body: hasBody ? JSON.stringify(body) : undefined,
  });

  if (response.ok) {
    return;
  }

  const responseBody: unknown = await response.json().catch(() => null);
  const parsed = parseApiErrorBody(responseBody);
  if (parsed) {
    throw new ApiRequestError(parsed.code, parsed.message, response.status);
  }
  throw new ApiRequestError("internal_error", "Request failed", response.status);
}

async function requestBlob(options: Omit<VoidRequestOptions, "body">): Promise<{
  blob: Blob;
  filename: string | null;
}> {
  const { method = "GET", path, credentials = null, tenantHeader = "none", query } = options;

  const response = await fetch(buildUrl(path, query), {
    method,
    headers: buildHeaders(credentials, tenantHeader, false),
  });

  if (!response.ok) {
    const responseBody: unknown = await response.json().catch(() => null);
    const parsed = parseApiErrorBody(responseBody);
    if (parsed) {
      throw new ApiRequestError(parsed.code, parsed.message, response.status);
    }
    throw new ApiRequestError("internal_error", "Request failed", response.status);
  }

  return {
    blob: await response.blob(),
    filename: contentDispositionFilename(response.headers.get("Content-Disposition")),
  };
}

function contentDispositionFilename(header: string | null): string | null {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? null;
}

export type SessionsListParams = {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  status?: string;
  tags?: TagFilterValue;
};

export type SnapshotsListParams = {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  deleted?: "active" | "deleted" | "all";
  tags?: TagFilterValue;
};

export type TenantsListParams = {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  deleted?: "active" | "deleted" | "all";
};

export type TokensListParams = {
  limit?: number;
  cursor?: string;
  tenantId?: string;
  name?: string;
  authorityType?: "system_admin" | "tenant";
  revoked?: "all" | "active" | "revoked";
  scope?: string;
};

export type EventsListParams = {
  limit?: number;
  cursor?: string;
  resourceType?: string;
  resourceId?: string;
};

export type CreateSessionInput = {
  baseSnapshotName?: string | null;
  label?: string | null;
  browser: {
    channel: string;
    args?: string[];
  };
  tags?: Record<string, string>;
};

export type PromoteSessionInput = {
  name: string;
  description?: string | null;
  force?: boolean;
  tags?: Record<string, string>;
};

export type UpdateSnapshotInput = {
  description: string | null;
};

export type CreateAdminTokenInput = {
  name: string;
  authorityType: "system_admin" | "tenant";
  tenantId?: string | null;
  scopes: string[];
  expiresAt?: string | null;
};

export type CreateTenantTokenInput = {
  name: string;
  scopes: string[];
  expiresAt?: string | null;
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

  getBrowserChannels(credentials: ApiCredentials) {
    return request({
      path: "/api/browser/channels",
      schema: browserChannelsSchema,
      credentials,
      tenantHeader: "tenant-scoped",
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
        deleted: params.deleted,
      },
    });
  },

  createTenant(credentials: ApiCredentials, input: { displayName: string }) {
    return request({
      method: "POST",
      path: "/api/admin/tenants",
      schema: tenantSchema,
      credentials,
      body: input,
    });
  },

  updateTenant(credentials: ApiCredentials, tenantId: string, input: { displayName: string }) {
    return request({
      method: "PATCH",
      path: `/api/admin/tenants/${tenantId}`,
      schema: tenantSchema,
      credentials,
      body: input,
    });
  },

  deleteTenant(credentials: ApiCredentials, tenantId: string) {
    return request({
      method: "DELETE",
      path: `/api/admin/tenants/${tenantId}`,
      schema: tenantSchema,
      credentials,
    });
  },

  restoreTenant(credentials: ApiCredentials, tenantId: string) {
    return request({
      method: "POST",
      path: `/api/admin/tenants/${tenantId}/restore`,
      schema: tenantSchema,
      credentials,
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
        tagKey: params.tags?.map((tag) => tag.key),
        tagOperator: params.tags?.map((tag) => tag.operator),
        tagValue: params.tags?.map((tag) => tag.values.join(",")),
      },
    });
  },

  createSession(credentials: ApiCredentials, input: CreateSessionInput) {
    return request({
      method: "POST",
      path: "/api/sessions",
      schema: createSessionResponseSchema,
      credentials,
      tenantHeader: "tenant-scoped",
      body: {
        baseSnapshotName: input.baseSnapshotName ?? null,
        label: input.label ?? null,
        browser: {
          channel: input.browser.channel,
          args: input.browser.args ?? [],
        },
        tags: input.tags ?? {},
      },
    });
  },

  deleteSession(credentials: ApiCredentials, sessionId: string) {
    return request({
      method: "DELETE",
      path: `/api/sessions/${sessionId}`,
      schema: sessionMutationResponseSchema,
      credentials,
      tenantHeader: "tenant-scoped",
    });
  },

  reopenSession(credentials: ApiCredentials, sessionId: string) {
    return request({
      method: "POST",
      path: `/api/sessions/${sessionId}/reopen`,
      schema: sessionMutationResponseSchema,
      credentials,
      tenantHeader: "tenant-scoped",
    });
  },

  suspendSession(credentials: ApiCredentials, sessionId: string) {
    return request({
      method: "POST",
      path: `/api/sessions/${sessionId}/suspend`,
      schema: sessionMutationResponseSchema,
      credentials,
      tenantHeader: "tenant-scoped",
    });
  },

  rotateSessionCdpToken(credentials: ApiCredentials, sessionId: string) {
    return request({
      method: "POST",
      path: `/api/sessions/${sessionId}/cdp-token/rotate`,
      schema: sessionMutationResponseSchema,
      credentials,
      tenantHeader: "tenant-scoped",
    });
  },

  promoteSession(credentials: ApiCredentials, sessionId: string, input: PromoteSessionInput) {
    return request({
      method: "POST",
      path: `/api/sessions/${sessionId}/promote`,
      schema: promoteSessionResponseSchema,
      credentials,
      tenantHeader: "tenant-scoped",
      body: {
        name: input.name,
        description: input.description ?? null,
        force: input.force ?? false,
        tags: input.tags ?? {},
      },
    });
  },

  replaceSessionTags(credentials: ApiCredentials, sessionId: string, tags: Record<string, string>) {
    return request({
      method: "PUT",
      path: `/api/sessions/${sessionId}/tags`,
      schema: sessionMutationResponseSchema,
      credentials,
      tenantHeader: "tenant-scoped",
      body: { tags },
    });
  },

  getSessionScreencastStatus(credentials: ApiCredentials, sessionId: string) {
    return request({
      path: `/sessions/${encodeURIComponent(sessionId)}/screencast/status`,
      schema: screencastStatusSchema,
      credentials,
      tenantHeader: "tenant-scoped",
    });
  },

  startSessionScreencast(credentials: ApiCredentials, sessionId: string) {
    return request({
      method: "POST",
      path: `/sessions/${encodeURIComponent(sessionId)}/screencast/start`,
      schema: screencastStatusSchema,
      credentials,
      tenantHeader: "tenant-scoped",
      body: {},
    });
  },

  stopSessionScreencast(credentials: ApiCredentials, sessionId: string) {
    return requestBlob({
      method: "POST",
      path: `/sessions/${encodeURIComponent(sessionId)}/screencast/stop`,
      credentials,
      tenantHeader: "tenant-scoped",
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
        deleted: params.deleted,
        tagKey: params.tags?.map((tag) => tag.key),
        tagOperator: params.tags?.map((tag) => tag.operator),
        tagValue: params.tags?.map((tag) => tag.values.join(",")),
      },
    });
  },

  deleteSnapshot(credentials: ApiCredentials, name: string) {
    return request({
      method: "DELETE",
      path: `/api/snapshots/${encodeURIComponent(name)}`,
      schema: snapshotMutationResponseSchema,
      credentials,
      tenantHeader: "tenant-scoped",
    });
  },

  restoreSnapshot(credentials: ApiCredentials, name: string) {
    return request({
      method: "POST",
      path: `/api/snapshots/${encodeURIComponent(name)}/restore`,
      schema: snapshotMutationResponseSchema,
      credentials,
      tenantHeader: "tenant-scoped",
    });
  },

  replaceSnapshotTags(credentials: ApiCredentials, name: string, tags: Record<string, string>) {
    return request({
      method: "PUT",
      path: `/api/snapshots/${encodeURIComponent(name)}/tags`,
      schema: snapshotMutationResponseSchema,
      credentials,
      tenantHeader: "tenant-scoped",
      body: { tags },
    });
  },

  updateSnapshot(credentials: ApiCredentials, name: string, input: UpdateSnapshotInput) {
    return request({
      method: "PATCH",
      path: `/api/snapshots/${encodeURIComponent(name)}`,
      schema: snapshotMutationResponseSchema,
      credentials,
      tenantHeader: "tenant-scoped",
      body: input,
    });
  },

  listEvents(credentials: ApiCredentials, params: EventsListParams = {}) {
    return request({
      path: "/api/events",
      schema: eventsPageSchema,
      credentials,
      tenantHeader: "tenant-scoped",
      query: {
        limit: params.limit,
        cursor: params.cursor,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
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
        name: params.name,
        authorityType: params.authorityType,
        revoked: params.revoked,
        scope: params.scope,
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
        name: params.name,
        revoked: params.revoked,
        scope: params.scope,
      },
    });
  },

  createAdminToken(credentials: ApiCredentials, input: CreateAdminTokenInput) {
    return request({
      method: "POST",
      path: "/api/admin/tokens",
      schema: createTokenResponseSchema,
      credentials,
      body: {
        name: input.name,
        authorityType: input.authorityType,
        tenantId: input.tenantId ?? null,
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? null,
      },
    });
  },

  createTenantToken(credentials: ApiCredentials, input: CreateTenantTokenInput) {
    return request({
      method: "POST",
      path: "/api/tenant/tokens",
      schema: createTokenResponseSchema,
      credentials,
      body: {
        name: input.name,
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? null,
      },
    });
  },

  revokeAdminToken(credentials: ApiCredentials, tokenId: string) {
    return requestVoid({
      method: "POST",
      path: `/api/admin/tokens/${tokenId}/revoke`,
      credentials,
    });
  },

  revokeTenantToken(credentials: ApiCredentials, tokenId: string) {
    return requestVoid({
      method: "POST",
      path: `/api/tenant/tokens/${tokenId}/revoke`,
      credentials,
    });
  },
};
