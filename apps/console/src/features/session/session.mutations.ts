import type { ProxyConfig } from "@aperture-browser/control-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { noteAsked } from "#/features/session/new-sessions.ts";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

type NewSessionOptions = {
  snapshotId?: string;
  label?: string;
  workspaceId?: string;
  tags?: Record<string, string>;
  proxy?: ProxyConfig;
};

/**
 * Asks for a session and opens its workbench at once, before there is a session: the
 * workbench says it starts, and takes the session's address when there is one.
 */
export function useOpenNewSession() {
  const queries = useQueryClient();
  const navigate = useNavigate();
  return (options: NewSessionOptions = {}) => {
    const making = call((api) => api.sessions.create({ payload: options }));
    void making
      .then((session) => queries.setQueryData(queryKeys.session(session.id), session))
      // Told of in the workbench that waits for it.
      .catch(() => undefined)
      .finally(() => queries.invalidateQueries({ queryKey: queryKeys.sessions }));
    return navigate({ to: "/-/sessions/$sessionId", params: { sessionId: noteAsked(making) } });
  };
}

export function useDescribeSessionMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (said: { id: string; label: string | null; tags: Record<string, string> }) =>
      call((api) =>
        api.sessions.describe({
          params: { id: said.id },
          payload: { label: said.label, tags: said.tags },
        }),
      ),
    onError: (error) => toastMutationError(error, "The session was not changed"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}

/** The same thing done to several sessions, told of once. */
export function useBulkSessionActionMutation(action: "suspend" | "resume" | "delete") {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (ids: ReadonlyArray<string>) => {
      const done = await Promise.allSettled(
        ids.map((id) => call((api) => api.sessions[action]({ params: { id } }))),
      );
      return {
        done: done.filter((one) => one.status === "fulfilled").length,
        failed: done.filter((one) => one.status === "rejected").length,
      };
    },
    onSuccess: ({ done, failed }) => {
      const what = { suspend: "suspended", resume: "resumed", delete: "deleted" }[action];
      if (failed === 0) {
        toast.success(`${done} ${what}`);
      } else {
        toast.error(`${done} ${what}, ${failed} failed`);
      }
    },
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
