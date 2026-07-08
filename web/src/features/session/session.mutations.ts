import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, type CreateSessionInput, type PromoteSessionInput } from "#/lib/api/client.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

function useInvalidateSessions() {
  const queryClient = useQueryClient();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";

  return () => {
    void queryClient.invalidateQueries({ queryKey: ["sessions", profileId] });
    void queryClient.invalidateQueries({ queryKey: ["events", profileId] });
  };
}

export function useCreateSessionMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (input: CreateSessionInput) => apiClient.createSession(credentials!, input),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Create failed"),
  });
}

export function useDeleteSessionMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) => apiClient.deleteSession(credentials!, sessionId),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Delete failed"),
  });
}

export function useReopenSessionMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) => apiClient.reopenSession(credentials!, sessionId),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Reopen failed"),
  });
}

export function useSuspendSessionMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) => apiClient.suspendSession(credentials!, sessionId),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Suspend failed"),
  });
}

export function useRotateCdpTokenMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) => apiClient.rotateSessionCdpToken(credentials!, sessionId),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Rotate failed"),
  });
}

export function usePromoteSessionMutation() {
  const credentials = useApiCredentials();
  const invalidateSessions = useInvalidateSessions();
  const queryClient = useQueryClient();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";

  return useMutation({
    mutationFn: ({ sessionId, input }: { sessionId: string; input: PromoteSessionInput }) =>
      apiClient.promoteSession(credentials!, sessionId, input),
    onSuccess: () => {
      invalidateSessions();
      void queryClient.invalidateQueries({ queryKey: ["snapshots", profileId] });
    },
    onError: (error) => toastMutationError(error, "Promote failed"),
  });
}

export function useReplaceSessionTagsMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: ({ sessionId, tags }: { sessionId: string; tags: Record<string, string> }) =>
      apiClient.replaceSessionTags(credentials!, sessionId, tags),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Tags update failed"),
  });
}
