import { useQuery } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { queryKeys } from "#/lib/query-keys.ts";

const listTokens = (accountId: string | undefined) =>
  call((api) =>
    accountId === undefined
      ? api.accounts.tokens()
      : api.accounts.tokensOf({ params: { id: accountId } }),
  );

export type ApiToken = Awaited<ReturnType<typeof listTokens>>[number];

/** The tokens of the account that is signed in, or of another's for an admin. */
export function useTokensQuery(accountId?: string) {
  return useQuery({
    queryKey: [...queryKeys.tokens, accountId ?? null],
    queryFn: () => listTokens(accountId),
  });
}
