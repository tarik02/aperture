import { useQuery } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { queryKeys } from "#/lib/query-keys.ts";

const listTokens = () => call((api) => api.accounts.tokens());

export type ApiToken = Awaited<ReturnType<typeof listTokens>>[number];

export function useTokensQuery() {
  return useQuery({ queryKey: queryKeys.tokens, queryFn: listTokens });
}
