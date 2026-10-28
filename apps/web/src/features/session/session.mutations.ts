import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import {
  ApiRequestError,
  SessionsApi,
  type CreateSessionInput,
  type Session,
  type UpdateProxyConfig,
} from "@aperture-browser/api-client";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { useTenantApi } from "#/hooks/use-tenant-api.ts";

function useInvalidateSessions() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["session"] });
    void queryClient.invalidateQueries({ queryKey: ["sessions-bulk"] });
    void queryClient.invalidateQueries({ queryKey: ["browser-status"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
  };
}

export function useCreateSessionMutation() {
  const api = useTenantApi();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (input: CreateSessionInput) =>
      api.run((credentials) =>
        SessionsApi.use((sessions) =>
          sessions.createSession(credentials, input, { waitForReady: false }),
        ),
      ),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Create failed"),
  });
}

export function useDeleteSessionMutation() {
  const api = useTenantApi();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) =>
      api.run((credentials) =>
        SessionsApi.use((sessions) => sessions.deleteSession(credentials, sessionId)),
      ),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Delete failed"),
  });
}

export function useReopenSessionMutation() {
  const api = useTenantApi();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) =>
      api.run((credentials) =>
        SessionsApi.use((sessions) => sessions.reopenSession(credentials, sessionId)),
      ),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Reopen failed"),
  });
}

export function useSuspendSessionMutation() {
  const api = useTenantApi();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) =>
      api.run((credentials) =>
        SessionsApi.use((sessions) => sessions.suspendSession(credentials, sessionId)),
      ),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Suspend failed"),
  });
}

export function useRotateSessionTokenMutation() {
  const api = useTenantApi();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: (sessionId: string) =>
      api.run((credentials) =>
        SessionsApi.use((sessions) => sessions.rotateSessionToken(credentials, sessionId)),
      ),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Rotate failed"),
  });
}

export interface SaveToSnapshotInput {
  readonly session: Session;
  readonly name: string;
  readonly description: string | null;
  /** Replace the snapshot of that name instead of failing when it exists. */
  readonly replace: boolean;
}

export const saveToSnapshotMutationKey = ["save-to-snapshot"] as const;

/**
 * Snapshots are saved from a stopped browser, so a running session is suspended first. The
 * session is kept: deleting it would discard what is being saved.
 */
export function useSaveToSnapshotMutation() {
  const api = useTenantApi();
  const invalidateSessions = useInvalidateSessions();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: saveToSnapshotMutationKey,
    mutationFn: ({ session, name, description, replace }: SaveToSnapshotInput) =>
      api.run((credentials) =>
        SessionsApi.use((sessions) =>
          Effect.gen(function* () {
            // A cached status can be stale: opening a suspended session wakes it.
            const current = yield* sessions.getSession(credentials, session.id);
            if (current.status === "running") {
              yield* sessions.suspendSession(credentials, session.id).pipe(
                // It stopped on its own between the read and the suspend.
                Effect.catchIf(
                  (error) =>
                    error instanceof ApiRequestError && error.code === "session_invalid_state",
                  () => Effect.void,
                ),
              );
            }
            return yield* sessions.promoteSession(credentials, session.id, {
              name,
              description,
              force: replace,
            });
          }).pipe(
            // Another tab connected to the session wakes it right after the suspend; suspend
            // it again and retry once.
            Effect.retry({
              times: 1,
              while: (error) =>
                error instanceof ApiRequestError && error.code === "session_not_promotable",
            }),
          ),
        ),
      ),
    onSettled: () => {
      invalidateSessions();
      void queryClient.invalidateQueries({ queryKey: ["snapshots"] });
    },
  });
}

export function useUpdateSessionProxyMutation() {
  const api = useTenantApi();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: ({ sessionId, proxy }: { sessionId: string; proxy: UpdateProxyConfig }) =>
      api.run((credentials) =>
        SessionsApi.use((sessions) => sessions.updateSessionProxy(credentials, sessionId, proxy)),
      ),
    onSuccess: invalidate,
  });
}

export function useReplaceSessionTagsMutation() {
  const api = useTenantApi();
  const invalidate = useInvalidateSessions();

  return useMutation({
    mutationFn: ({ sessionId, tags }: { sessionId: string; tags: Record<string, string> }) =>
      api.run((credentials) =>
        SessionsApi.use((sessions) => sessions.replaceSessionTags(credentials, sessionId, tags)),
      ),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Tags update failed"),
  });
}
