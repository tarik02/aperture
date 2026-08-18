import type { TagFilterValue } from "#/lib/tag-filter.ts";

export const queryKeys = {
  apiHealth: ["api-health"] as const,
  authMe: (profileId: string, tenantId: string | null) => ["auth-me", profileId, tenantId] as const,
  passkeys: ["passkeys"] as const,
  browserChannels: (profileId: string, tenantId: string | null) =>
    ["browser-channels", profileId, tenantId] as const,
  browserStatus: (sessionId: string, revision: number) =>
    ["browser-status", sessionId, revision] as const,
  tenants: (profileId: string, filters: TenantsFilters) => ["tenants", profileId, filters] as const,
  users: (profileId: string, filters: UsersFilters) => ["users", profileId, filters] as const,
  user: (profileId: string, userId: string) => ["user", profileId, userId] as const,
  userMemberships: (profileId: string, userId: string) =>
    ["user-memberships", profileId, userId] as const,
  sessions: (profileId: string, tenantId: string | null, filters: SessionsFilters) =>
    ["sessions", profileId, tenantId, filters] as const,
  session: (profileId: string, tenantId: string | null, sessionId: string) =>
    ["session", profileId, tenantId, sessionId] as const,
  sessionsBulk: (profileId: string, tenantId: string | null, sessionIds: string[]) =>
    ["sessions-bulk", profileId, tenantId, sessionIds] as const,
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

export type UsersFilters = {
  query?: string;
  disabled?: UserDisabledFilterValue;
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
  name?: string;
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
export type UserDisabledFilterValue = "active" | "disabled" | "all";
export type TokenRevokedFilterValue = "all" | "active" | "revoked";

export type EventsFilters = {
  resourceType?: string;
  resourceId?: string;
  limit?: number;
};
