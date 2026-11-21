import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

const listTokens = () => call((api) => api.accounts.tokens());

export type ApiToken = Awaited<ReturnType<typeof listTokens>>[number];

export function useTokensQuery() {
  return useQuery({ queryKey: queryKeys.tokens, queryFn: listTokens });
}

export function useCreateTokenMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (token: { name: string; expiresInDays: number | undefined }) =>
      call((api) => api.accounts.createOwnToken({ payload: token })),
    onError: (error) => toastMutationError(error, "The token was not made"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.tokens }),
  });
}

export function useRevokeTokenMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call((api) => api.accounts.revokeToken({ params: { id } })),
    onError: (error) => toastMutationError(error, "The token was not revoked"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.tokens }),
  });
}
