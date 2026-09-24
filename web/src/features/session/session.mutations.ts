import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateSessionInput, PromoteSessionInput } from "@aperture/api-client";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { runApi } from "#/lib/runtime.ts";

function useInvalidateSessions() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["session"] });
    void queryClient.invalidateQueries({ queryKey: ["sessions-bulk"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
  };
}

export function useCreateSessionMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (input: CreateSessionInput) =>
      runApi((api) => api.createSession(credentials!, input)),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Create failed"),
  });
}

export function useDeleteSessionMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) => runApi((api) => api.deleteSession(credentials!, sessionId)),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Delete failed"),
  });
}

export function useReopenSessionMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) => runApi((api) => api.reopenSession(credentials!, sessionId)),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Reopen failed"),
  });
}

export function useSuspendSessionMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) => runApi((api) => api.suspendSession(credentials!, sessionId)),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Suspend failed"),
  });
}

export function useRotateSessionTokenMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) =>
      runApi((api) => api.rotateSessionToken(credentials!, sessionId)),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Rotate failed"),
  });
}

export function usePromoteSessionMutation() {
  const credentials = useApiCredentials();
  const invalidateSessions = useInvalidateSessions();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, input }: { sessionId: string; input: PromoteSessionInput }) =>
      runApi((api) => api.promoteSession(credentials!, sessionId, input)),
    onSuccess: () => {
      invalidateSessions();
      void queryClient.invalidateQueries({ queryKey: ["snapshots"] });
    },
    onError: (error) => toastMutationError(error, "Promote failed"),
  });
}

export function useReplaceSessionTagsMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: ({ sessionId, tags }: { sessionId: string; tags: Record<string, string> }) =>
      runApi((api) => api.replaceSessionTags(credentials!, sessionId, tags)),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Tags update failed"),
  });
}
