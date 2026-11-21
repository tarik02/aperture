import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

export function useAccountsQuery() {
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: () => call((api) => api.accounts.list()),
  });
}

export function useCreateAccountMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => call((api) => api.accounts.create({ payload: { name } })),
    onError: (error) => toastMutationError(error, "The account was not made"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

export function useCreateApiTokenMutation() {
  return useMutation({
    mutationFn: (accountId: string) =>
      call((api) =>
        api.accounts.createToken({ params: { id: accountId }, payload: { name: "console" } }),
      ),
    onError: (error) => toastMutationError(error, "The token was not made"),
  });
}
