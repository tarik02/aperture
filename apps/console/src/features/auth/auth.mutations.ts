import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { addPasskey, calledOff, removePasskey, renamePasskey } from "#/lib/identity.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

/** Has an authenticator make a passkey for whoever is signed in, kept under a name. */
export function useAddPasskeyMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: addPasskey,
    onSuccess: () => toast.success("The passkey was added"),
    onError: (error) =>
      calledOff(error) ? undefined : toastMutationError(error, "The passkey was not added"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.passkeys }),
  });
}

export function useRenamePasskeyMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (passkey: { id: string; name: string }) => renamePasskey(passkey.id, passkey.name),
    onError: (error) => toastMutationError(error, "The passkey was not renamed"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.passkeys }),
  });
}

export function useRemovePasskeyMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: removePasskey,
    onSuccess: () => toast.success("The passkey was removed"),
    onError: (error) => toastMutationError(error, "The passkey was not removed"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.passkeys }),
  });
}
