import { useQuery } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { queryKeys } from "#/lib/query-keys.ts";

const listGrants = () => call((api) => api.grants.list());

export type Grant = Awaited<ReturnType<typeof listGrants>>[number];

/** What the account that is signed in gave to apps. */
export function useGrantsQuery() {
  return useQuery({ queryKey: queryKeys.grants, queryFn: listGrants });
}

/** The app an authorization request names, where the request is one it may make. */
export function useAskingQuery(asked: { clientId: string; redirectUri: string }) {
  return useQuery({
    queryKey: queryKeys.asking(asked.clientId, asked.redirectUri),
    queryFn: () => call((api) => api.grants.asking({ query: asked })),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
