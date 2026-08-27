import { useQuery } from "@tanstack/react-query";
import { apiClient } from "#/lib/api/client.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys } from "#/lib/api/query-keys.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";
import type { ApiCredentials } from "#/lib/api/client.ts";

function resolveTenantKey(credentials: ApiCredentials | null): string | null {
  if (!credentials) {
    return null;
  }
  return credentials.authorityType === "tenant"
    ? credentials.tenantId
    : credentials.selectedTenantId;
}

export function useBrowserConfigurationsQuery() {
  const credentials = useApiCredentials();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";
  const tenantKey = resolveTenantKey(credentials);
  const enabled = isTenantScopedQueryReady(credentials);

  return useQuery({
    queryKey: queryKeys.browserConfigurations(profileId, tenantKey),
    queryFn: () => apiClient.getBrowserConfigurations(credentials!),
    enabled,
    staleTime: 60_000,
  });
}
