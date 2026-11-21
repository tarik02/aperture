import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

/** Makes a person's account, who signs in with the address, or a service's with a name alone. */
export function useCreateAccountMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (account: { name: string; email?: string }) =>
      call((api) =>
        api.accounts.create({
          payload: { ...account, kind: account.email === undefined ? "service" : "person" },
        }),
      ),
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

/** Turns the second factor of an account's person off, for one who lost what gives its codes. */
export function useResetSecondFactorMutation() {
  return useMutation({
    mutationFn: (accountId: string) =>
      call((api) => api.accounts.resetSecondFactor({ params: { id: accountId } })),
    onSuccess: () => toast.success("Two-factor sign-in is off for this account"),
    onError: (error) => toastMutationError(error, "The second factor was not reset"),
  });
}
