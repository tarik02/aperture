import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "#/lib/api/client.ts";
import { defaultListLimit, getNextPageParam, listQueryDefaults } from "#/lib/api/pagination.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys, type SessionsFilters } from "#/lib/api/query-keys.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";
import type { ApiCredentials } from "#/lib/api/client.ts";

function resolveTenantKey(credentials: ApiCredentials | null): string | null {
  if (!credentials) {
    return null;
  }
  return credentials.authorityType === "tenant"
    ? credentials.tenantId
    : credentials.selectedTenantId;
}

export function useSessionsInfiniteQuery(filters: SessionsFilters = {}) {
  const credentials = useApiCredentials();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";
  const tenantKey = resolveTenantKey(credentials);
  const enabled = isTenantScopedQueryReady(credentials);

  return useInfiniteQuery({
    queryKey: queryKeys.sessions(profileId, tenantKey, filters),
    queryFn: ({ pageParam }) =>
      apiClient.listSessions(credentials!, {
        limit: filters.limit ?? defaultListLimit,
        cursor: pageParam,
        includeDeleted: filters.includeDeleted,
        status: filters.status,
        tags: filters.tags,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam,
    enabled,
    ...listQueryDefaults,
  });
}
