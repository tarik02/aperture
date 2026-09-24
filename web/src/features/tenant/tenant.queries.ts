import { useInfiniteQuery } from "@tanstack/react-query";
import { defaultListLimit, getNextPageParam, listQueryDefaults } from "@aperture/api-client";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys, type TenantsFilters } from "#/lib/api/query-keys.ts";
import { runApi } from "#/lib/runtime.ts";

export function useTenantsInfiniteQuery(filters: TenantsFilters = {}) {
  const credentials = useApiCredentials();
  const enabled = credentials !== null && credentials.authorityType === "system_admin";

  return useInfiniteQuery({
    queryKey: queryKeys.tenants(filters),
    queryFn: ({ pageParam, signal }) =>
      runApi(
        (api) =>
          api.listTenants(credentials!, {
            limit: filters.limit ?? defaultListLimit,
            cursor: pageParam,
            includeDeleted: filters.includeDeleted,
            deleted: filters.deleted,
          }),
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam,
    enabled,
    ...listQueryDefaults,
  });
}
