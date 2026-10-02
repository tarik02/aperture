import { useInfiniteQuery } from "@tanstack/react-query";
import {
  type ApiCredentials,
  defaultListLimit,
  getNextPageParam,
  listQueryDefaults,
  SnapshotsApi,
} from "@aperture-browser/api-client";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys, type SnapshotsFilters } from "#/lib/api/query-keys.ts";
import { useRunApi } from "@aperture-browser/session-react";

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
  const runApi = useRunApi();
  const activeCredentials = useApiCredentials();
  const credentials = options.credentials === undefined ? activeCredentials : options.credentials;
  const tenantKey = resolveTenantKey(credentials);
  const enabled = isTenantScopedQueryReady(credentials) && options.enabled !== false;

  return useInfiniteQuery({
    queryKey: queryKeys.snapshots(tenantKey, filters),
    queryFn: ({ pageParam, signal }) =>
      runApi(
        SnapshotsApi.use((snapshots) =>
          snapshots.listSnapshots(credentials!, {
            limit: filters.limit ?? defaultListLimit,
            cursor: pageParam,
            includeDeleted: filters.includeDeleted,
            deleted: filters.deleted,
            name: filters.name,
            tags: filters.tags,
          }),
        ),
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam,
    enabled,
    ...listQueryDefaults,
  });
}
