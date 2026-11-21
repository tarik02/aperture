import type { Scope } from "@aperture-browser/control-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

type NewToken = {
  name: string;
  expiresInDays: number | undefined;
  /** What it is held to; whatever its account does, without. */
  scopes: ReadonlyArray<Scope> | undefined;
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

export function useRevokeTokenMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call((api) => api.accounts.revokeToken({ params: { id } })),
    onError: (error) => toastMutationError(error, "The token was not revoked"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.tokens }),
  });
}
