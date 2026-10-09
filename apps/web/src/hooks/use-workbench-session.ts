import { useQuery } from "@tanstack/react-query";
import { ApiRequestError, AuthApi } from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";
import { useSessionQuery } from "#/features/session/session.queries.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { selectAuth, useAuthSessionStore } from "#/stores/auth-session.ts";

export function useWorkbenchSession(sessionId: string) {
  const runApi = useRunApi();
  const auth = useAuthSessionStore(selectAuth);
  const credentials = useApiCredentials();
  const sessionQuery = useSessionQuery(sessionId);
  const tenantReady = isTenantScopedQueryReady(credentials);
  const lookupError = sessionQuery.error;
  const resolveTenant =
    !tenantReady ||
    (lookupError instanceof ApiRequestError &&
      (lookupError.status === 404 || lookupError.status === 403));
  const tenantQuery = useQuery({
    queryKey: [
      "session-tenant",
      auth?.principal.type,
      auth?.principal.id,
      auth?.selectedTenant?.id,
      sessionId,
    ],
    queryFn: ({ signal }) =>
      runApi(
        AuthApi.use((api) => api.resolveSessionTenant(sessionId)),
        { signal },
      ),
    enabled: auth !== null && sessionQuery.data === undefined && resolveTenant,
    retry: false,
  });

  return {
    session: sessionQuery.data ?? null,
    owningTenant: tenantQuery.data ?? null,
    isResolvingRoute: sessionQuery.isLoading || tenantQuery.isLoading,
    error: tenantQuery.error ?? lookupError,
    retry: async () => {
      if (tenantReady) {
        await sessionQuery.refetch();
      }
      if (resolveTenant) {
        await tenantQuery.refetch();
      }
    },
  };
}
