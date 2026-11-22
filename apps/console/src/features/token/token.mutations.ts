import type { Scope, TokenResources } from "@aperture-browser/control-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

type NewToken = {
  name: string;
  expiresInDays: number | undefined;
  /** What it does: at least one thing. */
  scopes: readonly [Scope, ...Scope[]];
  /** What it reaches; all that its account does, without. */
  resources: TokenResources | undefined;
};

/** Makes a token of the account that is signed in, or of another's for an admin. */
export function useCreateTokenMutation(accountId?: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (token: NewToken) =>
      call((api) =>
        accountId === undefined
          ? api.accounts.createOwnToken({ payload: token })
          : api.accounts.createToken({ params: { id: accountId }, payload: token }),
      ),
    onError: (error) => toastMutationError(error, "The token was not made"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.tokens }),
  });
}

/** Takes back a token of the account that is signed in, or of another's for an admin. */
export function useRevokeTokenMutation(accountId?: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      call((api) =>
        accountId === undefined
          ? api.accounts.revokeToken({ params: { id } })
          : api.accounts.revokeTokenOf({ params: { id: accountId, tokenId: id } }),
      ),
    onError: (error) => toastMutationError(error, "The token was not revoked"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.tokens }),
  });
}
