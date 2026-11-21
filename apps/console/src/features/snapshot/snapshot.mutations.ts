import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

export function useTakeSnapshotMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (taken: {
      sessionId: string;
      name: string | undefined;
      description?: string | undefined;
    }) =>
      call((api) =>
        api.snapshots.take({
          params: { id: taken.sessionId },
          payload: { name: taken.name, description: taken.description },
        }),
      ),
    onSuccess: () => toast.success("Snapshot saved"),
    onError: (error) => toastMutationError(error, "The snapshot was not saved"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.snapshots }),
  });
}

export function useDescribeSnapshotMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (said: {
      id: string;
      name: string | null;
      description: string | null;
      tags: Record<string, string>;
    }) =>
      call((api) =>
        api.snapshots.describe({
          params: { id: said.id },
          payload: { name: said.name, description: said.description, tags: said.tags },
        }),
      ),
    onError: (error) => toastMutationError(error, "The snapshot was not changed"),
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
