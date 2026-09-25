import { useMemo } from "react";
import * as Data from "effect/Data";
import type { ApiCredentials } from "@aperture-browser/api-client";
import { selectAuth, useAuthSessionStore } from "#/stores/auth-session.ts";

/** A query ran before the credentials it needs were available. */
export class ApiCredentialsUnavailableError extends Data.TaggedError(
  "ApiCredentialsUnavailableError",
) {
  override readonly message = "API credentials are unavailable";
}

export function useApiCredentials(): ApiCredentials | null {
  const auth = useAuthSessionStore(selectAuth);

  return useMemo(() => {
    if (!auth) {
      return null;
    }
    return {
      kind: "session",
      authorityType: auth.principal.authorityType,
      tenantId: auth.principal.tenantId ?? null,
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
