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
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      call((api) => api.accounts.resetSecondFactor({ params: { id: accountId } })),
    onSuccess: () => toast.success("Two-factor sign-in is off for this account"),
    onError: (error) => toastMutationError(error, "The second factor was not reset"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

/** Removes the passkeys of an account's person, for one who lost what holds them. */
export function useRemovePasskeysMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      call((api) => api.accounts.removePasskeys({ params: { id: accountId } })),
    onSuccess: () => toast.success("Their passkeys were removed"),
    onError: (error) => toastMutationError(error, "The passkeys were not removed"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

/** Disables an account, which then signs in nowhere, or puts a disabled one in use again. */
export function useDisableAccountMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (account: { id: string; disabled: boolean }) =>
      call((api) =>
        account.disabled
          ? api.accounts.disable({ params: { id: account.id } })
          : api.accounts.enable({ params: { id: account.id } }),
      ),
    onSuccess: (account) =>
      toast.success(
        account.disabledAt === null
          ? `${account.name} signs in again`
          : `${account.name} is disabled`,
      ),
    onError: (error) => toastMutationError(error, "The account was not changed"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

/** Removes an account for good, with its tokens, its connected apps and its places in workspaces. */
export function useRemoveAccountMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      call((api) => api.accounts.remove({ params: { id: accountId } })),
    onSuccess: () => toast.success("The account was deleted"),
    onError: (error) => toastMutationError(error, "The account was not deleted"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}
