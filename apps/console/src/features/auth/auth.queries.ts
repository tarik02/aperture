import { useQuery } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { queryKeys } from "#/lib/query-keys.ts";
import { useToken } from "#/lib/token.ts";

/**
 * The account that is signed in: the one of the token this browser keeps, or the one its
 * cookies sign in. It fails where neither signs anyone in.
 */
export function useAccountQuery() {
  // Asked anew when the token changes: who is signed in is another then.
  const token = useToken();
  return useQuery({
    queryKey: [...queryKeys.account, token ?? null],
    queryFn: () => call((api) => api.accounts.current()),
    staleTime: Infinity,
  });
}
