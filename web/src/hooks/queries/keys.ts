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
  limit?: number;
};

export type SessionsFilters = {
  includeDeleted?: boolean;
  status?: string;
  tagKey?: string;
  tagValue?: string;
  limit?: number;
};

export type SnapshotsFilters = {
  includeDeleted?: boolean;
  tagKey?: string;
  tagValue?: string;
  limit?: number;
};

export type TokensFilters = {
  tenantId?: string;
  limit?: number;
};

export type TokensQueryMode = "admin" | "tenant";

export type EventsFilters = {
  resourceType?: string;
  resourceId?: string;
  limit?: number;
};
