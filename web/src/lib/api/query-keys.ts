import type { TagFilterValue } from "#/lib/tag-filter.ts";

export const queryKeys = {
  apiHealth: ["api-health"] as const,
  passkeys: ["passkeys"] as const,
  securityStatus: ["security-status"] as const,
  browserConfigurations: (tenantId: string | null) =>
    ["browser-configurations", tenantId] as const,
  browserStatus: (sessionId: string, revision: number) =>
    ["browser-status", sessionId, revision] as const,
  tenants: (filters: TenantsFilters) => ["tenants", filters] as const,
  users: (filters: UsersFilters) => ["users", filters] as const,
  user: (userId: string) => ["user", userId] as const,
  userMemberships: (userId: string) => ["user-memberships", userId] as const,
  sessions: (tenantId: string | null, filters: SessionsFilters) =>
    ["sessions", tenantId, filters] as const,
  session: (tenantId: string | null, sessionId: string) =>
    ["session", tenantId, sessionId] as const,
  sessionsBulk: (tenantId: string | null, sessionIds: string[]) =>
    ["sessions-bulk", tenantId, sessionIds] as const,
  snapshots: (tenantId: string | null, filters: SnapshotsFilters) =>
    ["snapshots", tenantId, filters] as const,
  tokens: (mode: TokensQueryMode, filters: TokensFilters) => ["tokens", mode, filters] as const,
  events: (tenantId: string | null, filters: EventsFilters) =>
    ["events", tenantId, filters] as const,
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
