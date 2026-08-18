import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { apiClient } from "#/lib/api/client.ts";
import { defaultListLimit, getNextPageParam, listQueryDefaults } from "#/lib/api/pagination.ts";
import { queryKeys, type UsersFilters } from "#/lib/api/query-keys.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

export function useUsersInfiniteQuery(filters: UsersFilters = {}) {
  const credentials = useApiCredentials();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";
  const enabled = credentials !== null && credentials.authorityType === "system_admin";

  return useInfiniteQuery({
    queryKey: queryKeys.users(profileId, filters),
    queryFn: ({ pageParam }) =>
      apiClient.listUsers(credentials!, {
        limit: filters.limit ?? defaultListLimit,
        cursor: pageParam,
        query: filters.query,
        disabled: filters.disabled,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam,
    enabled,
    ...listQueryDefaults,
  });
}

export function useUserQuery(userId: string | null) {
  const credentials = useApiCredentials();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";

  return useQuery({
    queryKey: queryKeys.user(profileId, userId ?? "none"),
    queryFn: () => apiClient.getUser(credentials!, userId!),
    enabled:
      userId !== null && credentials !== null && credentials.authorityType === "system_admin",
  });
}

export function useUserMembershipsQuery(userId: string | null) {
  const credentials = useApiCredentials();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";

  return useQuery({
    queryKey: queryKeys.userMemberships(profileId, userId ?? "none"),
    queryFn: () => apiClient.listUserMemberships(credentials!, userId!),
    enabled:
      userId !== null && credentials !== null && credentials.authorityType === "system_admin",
  });
}
