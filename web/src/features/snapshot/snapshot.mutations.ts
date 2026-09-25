import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { SnapshotsApi } from "@aperture/api-client";
import { useRunApi } from "#/lib/effect/react.tsx";

function useInvalidateSnapshots() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["snapshots"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
  };
}

export function useDeleteSnapshotMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSnapshots();

  return useMutation({
    mutationFn: (name: string) =>
      runApi(SnapshotsApi.use((snapshots) => snapshots.deleteSnapshot(credentials!, name))),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Delete failed"),
  });
}

export function useRestoreSnapshotMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSnapshots();

  return useMutation({
    mutationFn: (name: string) =>
      runApi(SnapshotsApi.use((snapshots) => snapshots.restoreSnapshot(credentials!, name))),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Restore failed"),
  });
}

export function useReplaceSnapshotTagsMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSnapshots();

  return useMutation({
    mutationFn: ({ name, tags }: { name: string; tags: Record<string, string> }) =>
      runApi(
        SnapshotsApi.use((snapshots) => snapshots.replaceSnapshotTags(credentials!, name, tags)),
      ),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Tags update failed"),
  });
}

export function useUpdateSnapshotMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSnapshots();

  return useMutation({
    mutationFn: ({ name, description }: { name: string; description: string | null }) =>
      runApi(
        SnapshotsApi.use((snapshots) =>
          snapshots.updateSnapshot(credentials!, name, { description }),
        ),
      ),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Snapshot update failed"),
  });
}
