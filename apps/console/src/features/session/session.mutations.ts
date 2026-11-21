import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

export function useCreateSessionMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (
      options: { snapshotId?: string; label?: string; tags?: Record<string, string> } = {},
    ) => call((api) => api.sessions.create({ payload: options })),
    onError: (error) => toastMutationError(error, "The session was not created"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
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
