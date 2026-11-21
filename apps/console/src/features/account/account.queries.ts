import { useQuery } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { queryKeys } from "#/lib/query-keys.ts";

const listAccounts = () => call((api) => api.accounts.list());

export type Account = Awaited<ReturnType<typeof listAccounts>>[number];

export function useAccountsQuery(enabled = true) {
  return useQuery({ queryKey: queryKeys.accounts, queryFn: listAccounts, enabled });
}
