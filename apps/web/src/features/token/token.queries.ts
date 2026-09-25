import { useInfiniteQuery } from "@tanstack/react-query";
import {
  defaultListLimit,
  getNextPageParam,
  listQueryDefaults,
} from "@aperture-browser/api-client";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { queryKeys, type TokensFilters } from "#/lib/api/query-keys.ts";
import { TokensApi } from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";

export function useTokensInfiniteQuery(filters: TokensFilters = {}) {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const mode = credentials?.authorityType === "system_admin" ? "admin" : "tenant";
  const enabled =
    credentials !== null &&
    (credentials.authorityType === "system_admin" || credentials.authorityType === "tenant");

  return useInfiniteQuery({
    queryKey: queryKeys.tokens(mode, filters),
    queryFn: ({ pageParam, signal }) => {
      const params = {
        limit: filters.limit ?? defaultListLimit,
        cursor: pageParam,
        tenantId: filters.tenantId,
        name: filters.name,
        authorityType: filters.authorityType,
        revoked: filters.revoked,
        scope: filters.scope,
      };

      return credentials!.authorityType === "system_admin"
        ? runApi(
            TokensApi.use((tokens) => tokens.listAdminTokens(credentials!, params)),
            { signal },
          )
        : runApi(
            TokensApi.use((tokens) => tokens.listTenantTokens(credentials!, params)),
            { signal },
          );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam,
    enabled,
    ...listQueryDefaults,
  });
}
