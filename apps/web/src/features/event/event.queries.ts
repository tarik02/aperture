import { useInfiniteQuery } from "@tanstack/react-query";
import {
  defaultListLimit,
  getNextPageParam,
  listQueryDefaults,
} from "@aperture-browser/api-client";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys, type EventsFilters } from "#/lib/api/query-keys.ts";
import type { ApiCredentials } from "@aperture-browser/api-client";
import { EventsApi } from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";

function resolveTenantKey(credentials: ApiCredentials | null): string | null {
  if (!credentials) {
    return null;
  }
  return credentials.authorityType === "tenant"
    ? credentials.tenantId
    : credentials.selectedTenantId;
}

export function useEventsInfiniteQuery(filters: EventsFilters, enabled = true) {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const tenantKey = resolveTenantKey(credentials);
  const queryEnabled = enabled && isTenantScopedQueryReady(credentials);

  return useInfiniteQuery({
    queryKey: queryKeys.events(tenantKey, filters),
    queryFn: ({ pageParam, signal }) =>
      runApi(
        EventsApi.use((events) =>
          events.listEvents(credentials!, {
            limit: filters.limit ?? defaultListLimit,
            cursor: pageParam,
            resourceType: filters.resourceType,
            resourceId: filters.resourceId,
          }),
        ),
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam,
    enabled: queryEnabled,
    ...listQueryDefaults,
  });
}
