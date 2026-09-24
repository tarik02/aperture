import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@aperture/api-client";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys } from "#/lib/api/query-keys.ts";
import type { ApiCredentials } from "@aperture/api-client";

function resolveTenantKey(credentials: ApiCredentials | null): string | null {
  if (!credentials) {
    return null;
  }
  return credentials.authorityType === "tenant"
    ? credentials.tenantId
    : credentials.selectedTenantId;
}

export function useBrowserChannelsQuery() {
  const credentials = useApiCredentials();
  const tenantKey = resolveTenantKey(credentials);
  const enabled = isTenantScopedQueryReady(credentials);

  return useQuery({
    queryKey: queryKeys.browserChannels(tenantKey),
    queryFn: () => apiClient.getBrowserChannels(credentials!),
    enabled,
    staleTime: 60_000,
  });
}
