import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

export function useTakeSnapshotMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (taken: { sessionId: string; name: string | undefined }) =>
      call((api) =>
        api.snapshots.take({ params: { id: taken.sessionId }, payload: { name: taken.name } }),
      ),
    onSuccess: () => toast.success("Snapshot saved"),
    onError: (error) => toastMutationError(error, "The snapshot was not saved"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.snapshots }),
  });
}

export function useDeleteSnapshotMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call((api) => api.snapshots.delete({ params: { id } })),
    onError: (error) => toastMutationError(error, "The snapshot was not deleted"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.snapshots }),
  });
}
