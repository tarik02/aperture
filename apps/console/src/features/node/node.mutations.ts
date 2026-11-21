import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

export function useCreateRegistrationTokenMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      call((api) => api.nodes.createRegistrationToken({ payload: { name } })),
    onError: (error) => toastMutationError(error, "The token was not made"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.registrationTokens }),
  });
}
