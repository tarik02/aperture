import type { Scope, TokenResources } from "@aperture-browser/control-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

type Approval = {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  /** What the app does: at least one thing. */
  scopes: readonly [Scope, ...Scope[]];
  /** What it reaches; all that the account does, without. */
  resources: TokenResources | undefined;
};

/** Gives an app a grant, and tells where the browser goes back to it. */
export function useApproveMutation() {
  return useMutation({
    mutationFn: (approval: Approval) => call((api) => api.grants.approve({ payload: approval })),
    onError: (error) => toastMutationError(error, "The app was not connected"),
  });
}

export function useRevokeGrantMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call((api) => api.grants.revoke({ params: { id } })),
    onError: (error) => toastMutationError(error, "The app was not disconnected"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.grants }),
  });
}
