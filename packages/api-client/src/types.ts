import type * as Api from "@aperture/api-schema";
import type { ResourceGrant, ResourceMode } from "./schemas.ts";

export const TENANT_HEADER = "X-Aperture-Tenant-Id";

export type TagFilterValue = Array<{
  key: string;
  operator: "eq" | "neq" | "in" | "not_in";
  values: string[];
}>;

type CredentialContext = {
  authorityType: "system_admin" | "tenant" | null;
  tenantId: string | null;
  selectedTenantId: string | null;
};

export type ApiCredentials =
  | (CredentialContext & {
      kind: "bearer";
      token: string;
    })
  | (CredentialContext & {
      kind: "session";
    });

/** The browser's own login session, sent as a cookie. */
export const webSessionCredentials: ApiCredentials = {
  kind: "session",
  authorityType: null,
  tenantId: null,
  selectedTenantId: null,
};

export type TenantHeaderMode = "none" | "optional" | "tenant-scoped";

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
    if (credentials.kind === "bearer") {
      return undefined;
    }
    return credentials.tenantId ?? undefined;
  }

  if (credentials.authorityType === "system_admin") {
    return credentials.selectedTenantId ?? undefined;
  }

  return undefined;
}

export type SessionsListParams = {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  status?: Api.SessionStatus;
  tags?: TagFilterValue;
};

export type SnapshotsListParams = {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  deleted?: "active" | "deleted" | "all";
  name?: string;
  tags?: TagFilterValue;
};

export type TenantsListParams = {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  deleted?: "active" | "deleted" | "all";
};

export type UsersListParams = {
  limit?: number;
  cursor?: string;
  query?: string;
  disabled?: "active" | "disabled" | "all";
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

export type InitialBrowserTarget = Api.InitialBrowserTarget;
export type InitialBrowserStorageState = Api.InitialBrowserStorageState;

export type CreateSessionInput = {
  baseSnapshotName?: string | null;
  label?: string | null;
  browser: {
    channel: string;
    args?: string[];
  };
  initialTargets?: readonly InitialBrowserTarget[];
  storageState?: InitialBrowserStorageState;
  tags?: Record<string, string>;
};

export interface CreateSessionOptions {
  waitForReady?: boolean;
}

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
  resourceMode: ResourceMode;
  resourceGrants: ResourceGrant[];
  expiresAt?: string | null;
};

export type CreateTenantTokenInput = {
  name: string;
  scopes: string[];
  resourceMode: ResourceMode;
  resourceGrants: ResourceGrant[];
  expiresAt?: string | null;
};

export type UserInput = {
  email: string | null;
  displayName: string;
  isSystemAdmin: boolean;
};

export type DownloadedFile = {
  blob: Blob;
  filename: string | null;
};
