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
    mutationFn: (account: { name: string; email?: string }) =>
      call((api) => api.accounts.create({ payload: account })),
    onError: (error) => toastMutationError(error, "The account was not made"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

/** A link with which the person of an account sets a password. */
export function useSetupLinkMutation() {
  return useMutation({
    mutationFn: async (accountId: string) => {
      const { token } = await call((api) =>
        api.accounts.createSetupToken({ params: { id: accountId } }),
      );
      // After the `#`, so the token is sent nowhere when the link is opened.
      return `${location.origin}/invite#token=${encodeURIComponent(token)}`;
    },
    onError: (error) => toastMutationError(error, "The link was not made"),
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
