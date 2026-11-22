import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";
import type { WorkspaceRole } from "#/lib/words.ts";

const workspacesOf = (accountId: string) =>
  call((api) => api.workspaces.ofAccount({ params: { accountId } }));

/** A workspace an account is in, with what the account does there. */
export type AccountWorkspace = Awaited<ReturnType<typeof workspacesOf>>[number];

/** The workspaces an account is in, as an admin is told them. */
export function useAccountWorkspacesQuery(accountId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.accountWorkspaces(accountId),
    queryFn: () => workspacesOf(accountId),
    enabled,
  });
}

/** Whatever tells who is in a workspace, or which an account is in, is stale after either changes. */
const changed = (queries: ReturnType<typeof useQueryClient>, accountId: string) =>
  Promise.all([
    queries.invalidateQueries({ queryKey: queryKeys.accountWorkspaces(accountId) }),
    queries.invalidateQueries({ queryKey: queryKeys.workspaces }),
  ]);

/** Puts an account into a workspace, or changes what it does there. */
export function usePlaceAccountMutation(accountId: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (place: { workspaceId: string; role: WorkspaceRole }) =>
      call((api) =>
        api.workspaces.admit({
          params: { id: place.workspaceId, accountId },
          payload: { role: place.role },
        }),
      ),
    onError: (error) => toastMutationError(error, "The workspace was not changed"),
    onSettled: () => changed(queries, accountId),
  });
}

/** Takes an account out of a workspace. */
export function useUnplaceAccountMutation(accountId: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) =>
      call((api) => api.workspaces.dismiss({ params: { id: workspaceId, accountId } })),
    onError: (error) => toastMutationError(error, "The account was not removed from the workspace"),
    onSettled: () => changed(queries, accountId),
  });
}
