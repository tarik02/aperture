import { useMemo } from "react";
import type { ApiCredentials } from "#/lib/api/client.ts";
import { selectAuth, useAuthSessionStore } from "#/stores/auth-session.ts";

export function useApiCredentials(): ApiCredentials | null {
  const auth = useAuthSessionStore(selectAuth);

  return useMemo(() => {
    if (!auth) {
      return null;
    }
    return {
      kind: "session",
      authorityType: auth.principal.authorityType,
      tenantId: auth.principal.tenantId,
      selectedTenantId: auth.selectedTenant?.id ?? null,
    };
  }, [auth]);
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
