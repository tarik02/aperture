import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "#/lib/api/client.ts";
import { defaultListLimit, getNextPageParam, listQueryDefaults } from "#/lib/api/pagination.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys, type EventsFilters } from "#/hooks/queries/keys.ts";
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

export function useEventsInfiniteQuery(filters: EventsFilters, enabled = true) {
  const credentials = useApiCredentials();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";
  const tenantKey = resolveTenantKey(credentials);
  const queryEnabled = enabled && isTenantScopedQueryReady(credentials);

  return useInfiniteQuery({
    queryKey: queryKeys.events(profileId, tenantKey, filters),
    queryFn: ({ pageParam }) =>
      apiClient.listEvents(credentials!, {
        limit: filters.limit ?? defaultListLimit,
        cursor: pageParam,
        resourceType: filters.resourceType,
        resourceId: filters.resourceId,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam,
    enabled: queryEnabled,
    ...listQueryDefaults,
  });
}
