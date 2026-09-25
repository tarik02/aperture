import { useQuery } from "@tanstack/react-query";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys } from "#/lib/api/query-keys.ts";
import type { ApiCredentials } from "@aperture-browser/api-client";
import { SessionsApi } from "@aperture-browser/api-client";
import { useRunApi } from "#/lib/effect/react.tsx";

function resolveTenantKey(credentials: ApiCredentials | null): string | null {
  if (!credentials) {
    return null;
  }
  return credentials.authorityType === "tenant"
    ? credentials.tenantId
    : credentials.selectedTenantId;
}

export function useBrowserChannelsQuery() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const tenantKey = resolveTenantKey(credentials);
  const enabled = isTenantScopedQueryReady(credentials);

  return useQuery({
    queryKey: queryKeys.browserChannels(tenantKey),
    queryFn: ({ signal }) =>
      runApi(
        SessionsApi.use((sessions) => sessions.getBrowserChannels(credentials!)),
        { signal },
      ),
    enabled,
    staleTime: 60_000,
  });
}
