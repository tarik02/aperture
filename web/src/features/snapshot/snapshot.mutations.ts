import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "#/lib/api/client.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

function useInvalidateSnapshots() {
  const queryClient = useQueryClient();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";

  return () => {
    void queryClient.invalidateQueries({ queryKey: ["snapshots", profileId] });
    void queryClient.invalidateQueries({ queryKey: ["events", profileId] });
  };
}

export function useDeleteSnapshotMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSnapshots();

  return useMutation({
    mutationFn: (name: string) => apiClient.deleteSnapshot(credentials!, name),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Delete failed"),
  });
}

export function useRestoreSnapshotMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSnapshots();

  return useMutation({
    mutationFn: (name: string) => apiClient.restoreSnapshot(credentials!, name),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Restore failed"),
  });
}

export function useReplaceSnapshotTagsMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSnapshots();

  return useMutation({
    mutationFn: ({ name, tags }: { name: string; tags: Record<string, string> }) =>
      apiClient.replaceSnapshotTags(credentials!, name, tags),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Tags update failed"),
  });
}

export function useUpdateSnapshotMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSnapshots();

  return useMutation({
    mutationFn: ({ name, description }: { name: string; description: string | null }) =>
      apiClient.updateSnapshot(credentials!, name, { description }),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Snapshot update failed"),
  });
}
