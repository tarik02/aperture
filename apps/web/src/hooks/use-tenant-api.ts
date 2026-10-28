import { useCallback } from "react";
import * as Effect from "effect/Effect";
import type { ApiCredentials, ApiServices } from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";
import {
  ApiCredentialsUnavailableError,
  isTenantScopedQueryReady,
  useApiCredentials,
} from "#/hooks/use-api-credentials.ts";

/** The tenant a tenant-scoped query reads, used to keep cache entries of tenants apart. */
export function resolveTenantKey(credentials: ApiCredentials | null): string | null {
  if (!credentials) {
    return null;
  }
  return credentials.authorityType === "tenant"
    ? credentials.tenantId
    : credentials.selectedTenantId;
}

/**
 * Everything a tenant-scoped query or mutation needs: the active credentials, the cache key of
 * their tenant, and `run`, which hands the credentials to an API call and runs it on the app
 * runtime. `run` fails with ApiCredentialsUnavailableError instead of sending an anonymous
 * request when no credentials are loaded yet.
 */
export function useTenantApi() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();

  const run = useCallback(
    <A, E>(
      call: (credentials: ApiCredentials) => Effect.Effect<A, E, ApiServices>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<A> => {
      const program: Effect.Effect<A, E | ApiCredentialsUnavailableError, ApiServices> =
        credentials === null
          ? Effect.fail(new ApiCredentialsUnavailableError())
          : call(credentials);
      return runApi(program, options);
    },
    [credentials, runApi],
  );

  return {
    credentials,
    tenantKey: resolveTenantKey(credentials),
    ready: isTenantScopedQueryReady(credentials),
    run,
  };
}
