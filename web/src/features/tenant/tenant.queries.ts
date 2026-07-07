import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "#/lib/api/client.ts";
import { defaultListLimit, getNextPageParam, listQueryDefaults } from "#/lib/api/pagination.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys, type TenantsFilters } from "#/lib/api/query-keys.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

export function useTenantsInfiniteQuery(filters: TenantsFilters = {}) {
  const credentials = useApiCredentials();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";
  const enabled = credentials !== null && credentials.authorityType === "system_admin";

  return useInfiniteQuery({
    queryKey: queryKeys.tenants(profileId, filters),
    queryFn: ({ pageParam }) =>
      apiClient.listTenants(credentials!, {
        limit: filters.limit ?? defaultListLimit,
        cursor: pageParam,
        includeDeleted: filters.includeDeleted,
        deleted: filters.deleted,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam,
    enabled,
    ...listQueryDefaults,
  });
}
