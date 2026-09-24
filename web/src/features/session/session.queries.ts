import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { defaultListLimit, getNextPageParam, listQueryDefaults } from "@aperture/api-client";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys, type SessionsFilters } from "#/lib/api/query-keys.ts";
import type { ApiCredentials } from "@aperture/api-client";
import { runApi } from "#/lib/runtime.ts";

function resolveTenantKey(credentials: ApiCredentials | null): string | null {
  if (!credentials) {
    return null;
  }
  return credentials.authorityType === "tenant"
    ? credentials.tenantId
    : credentials.selectedTenantId;
}

export function useSessionsInfiniteQuery(
  filters: SessionsFilters = {},
  options: { enabled?: boolean; credentials?: ApiCredentials | null } = {},
) {
  const activeCredentials = useApiCredentials();
  const credentials = options.credentials === undefined ? activeCredentials : options.credentials;
  const tenantKey = resolveTenantKey(credentials);
  const enabled = isTenantScopedQueryReady(credentials) && options.enabled !== false;

  return useInfiniteQuery({
    queryKey: queryKeys.sessions(tenantKey, filters),
    queryFn: ({ pageParam, signal }) =>
      runApi(
        (api) =>
          api.listSessions(credentials!, {
            limit: filters.limit ?? defaultListLimit,
            cursor: pageParam,
            includeDeleted: filters.includeDeleted,
            status: filters.status,
            tags: filters.tags,
          }),
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam,
    enabled,
    ...listQueryDefaults,
  });
}

export function useSessionsBulkQuery(sessionIds: string[]) {
  const credentials = useApiCredentials();
  const tenantKey = resolveTenantKey(credentials);
  const enabled = sessionIds.length > 0 && isTenantScopedQueryReady(credentials);

  return useQuery({
    queryKey: queryKeys.sessionsBulk(tenantKey, sessionIds),
    queryFn: ({ signal }) =>
      runApi((api) => api.getSessionsBulk(credentials!, sessionIds), { signal }),
    enabled,
    select: (response) => response.sessions,
  });
}

export function useSessionQuery(sessionId: string | undefined) {
  const credentials = useApiCredentials();
  const tenantKey = resolveTenantKey(credentials);

  return useQuery({
    queryKey: queryKeys.session(tenantKey, sessionId ?? "none"),
    queryFn: ({ signal }) => {
      if (!credentials || !sessionId) {
        throw new Error("Session credentials unavailable");
      }
      return runApi((api) => api.getSession(credentials, sessionId), { signal });
    },
    enabled: Boolean(sessionId && isTenantScopedQueryReady(credentials)),
    refetchInterval: (query) => (query.state.data?.status === "creating" ? 500 : false),
  });
}
