import type { TagFilterValue } from "#/lib/tag-filter.ts";

export const queryKeys = {
  apiHealth: ["api-health"] as const,
  authMe: (profileId: string, tenantId: string | null) => ["auth-me", profileId, tenantId] as const,
  browserChannels: (profileId: string, tenantId: string | null) =>
    ["browser-channels", profileId, tenantId] as const,
  tenants: (profileId: string, filters: TenantsFilters) => ["tenants", profileId, filters] as const,
  sessions: (profileId: string, tenantId: string | null, filters: SessionsFilters) =>
    ["sessions", profileId, tenantId, filters] as const,
  snapshots: (profileId: string, tenantId: string | null, filters: SnapshotsFilters) =>
    ["snapshots", profileId, tenantId, filters] as const,
  tokens: (profileId: string, mode: TokensQueryMode, filters: TokensFilters) =>
    ["tokens", profileId, mode, filters] as const,
  events: (profileId: string, tenantId: string | null, filters: EventsFilters) =>
    ["events", profileId, tenantId, filters] as const,
};

export type TenantsFilters = {
  includeDeleted?: boolean;
  deleted?: DeletedFilterValue;
  limit?: number;
};

export type SessionsFilters = {
  includeDeleted?: boolean;
  status?: string;
  tags?: TagFilterValue;
  limit?: number;
};

export type SnapshotsFilters = {
  includeDeleted?: boolean;
  deleted?: DeletedFilterValue;
  tags?: TagFilterValue;
  limit?: number;
};

export type TokensFilters = {
  tenantId?: string;
  name?: string;
  authorityType?: "system_admin" | "tenant";
  revoked?: TokenRevokedFilterValue;
  scope?: string;
  limit?: number;
};

export type TokensQueryMode = "admin" | "tenant";
export type DeletedFilterValue = "active" | "deleted" | "all";
export type TokenRevokedFilterValue = "all" | "active" | "revoked";

export type EventsFilters = {
  resourceType?: string;
  resourceId?: string;
  limit?: number;
};
