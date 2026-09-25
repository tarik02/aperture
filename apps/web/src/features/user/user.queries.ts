import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import {
  defaultListLimit,
  getNextPageParam,
  listQueryDefaults,
} from "@aperture-browser/api-client";
import { queryKeys, type UsersFilters } from "#/lib/api/query-keys.ts";
import { UsersApi } from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";

export function useUsersInfiniteQuery(filters: UsersFilters = {}) {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const enabled = credentials !== null && credentials.authorityType === "system_admin";

  return useInfiniteQuery({
    queryKey: queryKeys.users(filters),
    queryFn: ({ pageParam, signal }) =>
      runApi(
        UsersApi.use((users) =>
          users.listUsers(credentials!, {
            limit: filters.limit ?? defaultListLimit,
            cursor: pageParam,
            query: filters.query,
            disabled: filters.disabled,
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

export function useUserQuery(userId: string | null) {
  const runApi = useRunApi();
  const credentials = useApiCredentials();

  return useQuery({
    queryKey: queryKeys.user(userId ?? "none"),
    queryFn: ({ signal }) =>
      runApi(
        UsersApi.use((users) => users.getUser(credentials!, userId!)),
        { signal },
      ),
    enabled:
      userId !== null && credentials !== null && credentials.authorityType === "system_admin",
  });
}

export function useUserMembershipsQuery(userId: string | null) {
  const runApi = useRunApi();
  const credentials = useApiCredentials();

  return useQuery({
    queryKey: queryKeys.userMemberships(userId ?? "none"),
    queryFn: ({ signal }) =>
      runApi(
        UsersApi.use((users) => users.listUserMemberships(credentials!, userId!)),
        { signal },
      ),
    enabled:
      userId !== null && credentials !== null && credentials.authorityType === "system_admin",
  });
}
