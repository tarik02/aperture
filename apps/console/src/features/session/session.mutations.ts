import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

export function useCreateSessionMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (options: { snapshotId?: string } = {}) =>
      call((api) => api.sessions.create({ payload: options })),
    onError: (error) => toastMutationError(error, "The session was not created"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}

export function useSessionActionMutation(action: "suspend" | "resume" | "delete") {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call((api) => api.sessions[action]({ params: { id } })),
    onError: (error) => toastMutationError(error),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}
