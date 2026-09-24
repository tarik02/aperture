import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateSessionInput, PromoteSessionInput } from "@aperture/api-client";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { SessionsApi } from "@aperture/api-client";
import { useRunApi } from "#/lib/effect/react.tsx";

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
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (input: CreateSessionInput) =>
      runApi(SessionsApi.use((sessions) => sessions.createSession(credentials!, input))),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Create failed"),
  });
}

export function useDeleteSessionMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) =>
      runApi(SessionsApi.use((sessions) => sessions.deleteSession(credentials!, sessionId))),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Delete failed"),
  });
}

export function useReopenSessionMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) =>
      runApi(SessionsApi.use((sessions) => sessions.reopenSession(credentials!, sessionId))),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Reopen failed"),
  });
}

export function useSuspendSessionMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) =>
      runApi(SessionsApi.use((sessions) => sessions.suspendSession(credentials!, sessionId))),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Suspend failed"),
  });
}

export function useRotateSessionTokenMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) =>
      runApi(SessionsApi.use((sessions) => sessions.rotateSessionToken(credentials!, sessionId))),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Rotate failed"),
  });
}

export function usePromoteSessionMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidateSessions = useInvalidateSessions();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, input }: { sessionId: string; input: PromoteSessionInput }) =>
      runApi(
        SessionsApi.use((sessions) => sessions.promoteSession(credentials!, sessionId, input)),
      ),
    onSuccess: () => {
      invalidateSessions();
      void queryClient.invalidateQueries({ queryKey: ["snapshots"] });
    },
    onError: (error) => toastMutationError(error, "Promote failed"),
  });
}

export function useReplaceSessionTagsMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: ({ sessionId, tags }: { sessionId: string; tags: Record<string, string> }) =>
      runApi(
        SessionsApi.use((sessions) => sessions.replaceSessionTags(credentials!, sessionId, tags)),
      ),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Tags update failed"),
  });
}
