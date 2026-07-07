import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "#/lib/api/client.ts";
import { defaultListLimit, getNextPageParam, listQueryDefaults } from "#/lib/api/pagination.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys, type TokensFilters } from "#/lib/api/query-keys.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

export function useTokensInfiniteQuery(filters: TokensFilters = {}) {
  const credentials = useApiCredentials();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";
  const mode = credentials?.authorityType === "system_admin" ? "admin" : "tenant";
  const enabled =
    credentials !== null &&
    (credentials.authorityType === "system_admin" || credentials.authorityType === "tenant");

  return useInfiniteQuery({
    queryKey: queryKeys.tokens(profileId, mode, filters),
    queryFn: ({ pageParam }) => {
      const params = {
        limit: filters.limit ?? defaultListLimit,
        cursor: pageParam,
        tenantId: filters.tenantId,
        name: filters.name,
        authorityType: filters.authorityType,
        revoked: filters.revoked,
        scope: filters.scope,
      };

      return credentials!.authorityType === "system_admin"
        ? apiClient.listAdminTokens(credentials!, params)
        : apiClient.listTenantTokens(credentials!, params);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam,
    enabled,
    ...listQueryDefaults,
  });
}
