import { useMemo } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  ApiRequestError,
  defaultListLimit,
  getNextPageParam,
  listQueryDefaults,
  SessionsApi,
  type ApiCredentials,
  type Session,
  type SessionsPage,
} from "@aperture-browser/api-client";
import { isTenantScopedQueryReady } from "#/hooks/use-api-credentials.ts";
import { resolveTenantKey, useTenantApi } from "#/hooks/use-tenant-api.ts";
import { queryKeys, type SessionsFilters } from "#/lib/api/query-keys.ts";
import { isOpenable } from "#/features/session/session-display.ts";

const pollInterval = 10_000;

export function useSessionsInfiniteQuery(
  filters: SessionsFilters = {},
  options: { enabled?: boolean; credentials?: ApiCredentials | null; poll?: boolean } = {},
) {
  const api = useTenantApi();
  const credentials = options.credentials === undefined ? api.credentials : options.credentials;
  const tenantKey = resolveTenantKey(credentials);
  const enabled = isTenantScopedQueryReady(credentials) && options.enabled !== false;

  return useInfiniteQuery({
    queryKey: queryKeys.sessions(tenantKey, filters),
    queryFn: ({ pageParam, signal }) =>
      api.run(
        () =>
          SessionsApi.use((sessions) =>
            sessions.listSessions(credentials!, {
              limit: filters.limit ?? defaultListLimit,
              cursor: pageParam,
              includeDeleted: filters.includeDeleted,
              status: filters.status,
              query: filters.query,
              tags: filters.tags,
            }),
          ),
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam,
    enabled,
    // Keep rows on screen while a new search loads, but never show another tenant's rows.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === tenantKey ? previous : undefined,
    ...listQueryDefaults,
    // Polling pauses while the page is hidden and stops once the list fails, so a broken
    // connection is not hammered; focusing the window refetches it.
    refetchInterval: options.poll
      ? (query) => (query.state.status === "error" ? false : pollInterval)
      : false,
    refetchOnWindowFocus: options.poll ? "always" : listQueryDefaults.refetchOnWindowFocus,
  });
}

/** Sessions by id, in no particular order; callers order them. */
export function useSessionsBulkQuery(sessionIds: readonly string[]) {
  const api = useTenantApi();
  // Keyed by the set of ids, so reordering the same sessions reuses the cached response.
  const ids = useMemo(() => [...sessionIds].sort(), [sessionIds]);

  return useQuery({
    queryKey: queryKeys.sessionsBulk(api.tenantKey, ids),
    queryFn: ({ signal }) =>
      api.run(
        (credentials) => SessionsApi.use((sessions) => sessions.getSessionsBulk(credentials, ids)),
        { signal },
      ),
    enabled: ids.length > 0 && api.ready,
    // A new id keeps the previous sessions on screen until the response with it arrives.
    placeholderData: keepPreviousData,
    select: (response) => response.sessions,
  });
}

export function useSessionQuery(sessionId: string | undefined) {
  const api = useTenantApi();
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: queryKeys.session(api.tenantKey, sessionId ?? "none"),
    queryFn: ({ signal }) =>
      api.run(
        (credentials) =>
          SessionsApi.use((sessions) => sessions.getSession(credentials, sessionId!)),
        { signal },
      ),
    enabled: Boolean(sessionId && api.ready),
    // Switching sessions shows the listed copy at once while the full one, with credentials,
    // loads; callers wait for real data before connecting.
    placeholderData: () => {
      for (const [, data] of queryClient.getQueriesData<InfiniteData<SessionsPage>>({
        queryKey: ["sessions", api.tenantKey],
      })) {
        const listed = data?.pages
          .flatMap((page) => page.data)
          .find((session) => session.id === sessionId);
        if (listed) {
          return listed;
        }
      }
      return undefined;
    },
    retry: (failureCount, error) =>
      failureCount < 3 &&
      !(error instanceof ApiRequestError && (error.status === 403 || error.status === 404)),
    refetchInterval: (query) => (query.state.data?.status === "creating" ? 500 : false),
  });
}

/**
 * The pages of a running session, or those saved when it suspended. The endpoint is passive:
 * listing never opens a live connection or wakes the browser.
 */
export function useBrowserStatusQuery(session: Session, options: { enabled?: boolean } = {}) {
  const api = useTenantApi();
  const running = session.status === "running";

  return useQuery({
    queryKey: queryKeys.browserStatus(api.tenantKey, session.id, session.status),
    queryFn: ({ signal }) =>
      api.run(
        (credentials) =>
          SessionsApi.use((sessions) => sessions.getBrowserStatus(credentials, session.id)),
        { signal },
      ),
    enabled: api.ready && isOpenable(session.status) && options.enabled !== false,
    refetchInterval: (query) => (running && query.state.status !== "error" ? pollInterval : false),
    retry: 1,
  });
}
