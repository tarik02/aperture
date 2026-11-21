import { useQuery } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { queryKeys } from "#/lib/query-keys.ts";

/** The account that is signed in. */
export function useAccountQuery() {
  return useQuery({
    queryKey: queryKeys.account,
    queryFn: () => call((api) => api.accounts.current()),
    staleTime: Infinity,
  });
}
