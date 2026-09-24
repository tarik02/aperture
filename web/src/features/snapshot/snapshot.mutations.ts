import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { runApi } from "#/lib/runtime.ts";

function useInvalidateSnapshots() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["snapshots"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
  };
}

export function useDeleteSnapshotMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSnapshots();

  return useMutation({
    mutationFn: (name: string) => runApi((api) => api.deleteSnapshot(credentials!, name)),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Delete failed"),
  });
}

export function useRestoreSnapshotMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSnapshots();

  return useMutation({
    mutationFn: (name: string) => runApi((api) => api.restoreSnapshot(credentials!, name)),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Restore failed"),
  });
}

export function useReplaceSnapshotTagsMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSnapshots();

  return useMutation({
    mutationFn: ({ name, tags }: { name: string; tags: Record<string, string> }) =>
      runApi((api) => api.replaceSnapshotTags(credentials!, name, tags)),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Tags update failed"),
  });
}

export function useUpdateSnapshotMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSnapshots();

  return useMutation({
    mutationFn: ({ name, description }: { name: string; description: string | null }) =>
      runApi((api) => api.updateSnapshot(credentials!, name, { description })),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Snapshot update failed"),
  });
}
