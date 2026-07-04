import { useMemo } from "react";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";
import { credentialsFromProfile, type ApiCredentials } from "#/lib/api/client.ts";

export function useApiCredentials(): ApiCredentials | null {
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);

  return useMemo(() => {
    if (!activeProfile || !activeProfile.authorityType || bootstrapping) {
      return null;
    }
    return credentialsFromProfile(activeProfile);
  }, [activeProfile, bootstrapping]);
}

export function isTenantScopedQueryReady(credentials: ApiCredentials | null): boolean {
  if (!credentials) {
    return false;
  }

  if (credentials.authorityType === "tenant") {
    return credentials.tenantId !== null;
  }

  if (credentials.authorityType === "system_admin") {
    return credentials.selectedTenantId !== null;
  }

  return false;
}
