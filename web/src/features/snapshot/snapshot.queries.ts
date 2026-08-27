import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "#/lib/api/client.ts";
import { defaultListLimit, getNextPageParam, listQueryDefaults } from "#/lib/api/pagination.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys, type SnapshotsFilters } from "#/lib/api/query-keys.ts";
import type { ApiCredentials } from "#/lib/api/client.ts";

function resolveTenantKey(credentials: ApiCredentials | null): string | null {
  if (!credentials) {
    return null;
  }
  return credentials.authorityType === "tenant"
    ? credentials.tenantId
    : credentials.selectedTenantId;
}

export function useSnapshotsInfiniteQuery(
  filters: SnapshotsFilters = {},
  options: { enabled?: boolean; credentials?: ApiCredentials | null } = {},
) {
  const activeCredentials = useApiCredentials();
  const credentials = options.credentials === undefined ? activeCredentials : options.credentials;
  const tenantKey = resolveTenantKey(credentials);
  const enabled = isTenantScopedQueryReady(credentials) && options.enabled !== false;

  return useInfiniteQuery({
    queryKey: queryKeys.snapshots(tenantKey, filters),
    queryFn: ({ pageParam }) =>
      apiClient.listSnapshots(credentials!, {
        limit: filters.limit ?? defaultListLimit,
        cursor: pageParam,
        includeDeleted: filters.includeDeleted,
        deleted: filters.deleted,
        name: filters.name,
        tags: filters.tags,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam,
    enabled,
    ...listQueryDefaults,
  });
}
