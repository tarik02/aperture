import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  selectWorkspace,
  useSelectedWorkspaceId,
} from "#/features/workspace/selected-workspace.ts";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

const listWorkspaces = () => call((api) => api.workspaces.list());

export type Workspace = Awaited<ReturnType<typeof listWorkspaces>>[number];

export function useWorkspacesQuery() {
  return useQuery({ queryKey: queryKeys.workspaces, queryFn: listWorkspaces });
}

/**
 * The workspace that is selected, where the account is still in it; none for the
 * account's own, and for one that is gone since it was selected.
 */
export function useSelectedWorkspace() {
  const id = useSelectedWorkspaceId();
  const workspaces = useWorkspacesQuery();
  return workspaces.data?.find((workspace) => workspace.id === id) ?? null;
}

export function useWorkspaceMembersQuery(id: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.workspaceMembers(id),
    queryFn: () => call((api) => api.workspaces.members({ params: { id } })),
    enabled,
  });
}

export function useCreateWorkspaceMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => call((api) => api.workspaces.create({ payload: { name } })),
    onSuccess: (made) => selectWorkspace(made.id),
    onError: (error) => toastMutationError(error, "The workspace was not made"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.workspaces }),
  });
}

export function useDeleteWorkspaceMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call((api) => api.workspaces.delete({ params: { id } })),
    onError: (error) =>
      toastMutationError(
        error,
        "The workspace was not deleted: it may still have sessions or snapshots",
      ),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.workspaces }),
  });
}

export function useAdmitMemberMutation(id: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (member: { accountId: string; role: "member" | "admin" }) =>
      call((api) =>
        api.workspaces.admit({
          params: { id, accountId: member.accountId },
          payload: { role: member.role },
        }),
      ),
    onError: (error) => toastMutationError(error, "The member was not added"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.workspaceMembers(id) }),
  });
}

export function useDismissMemberMutation(id: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      call((api) => api.workspaces.dismiss({ params: { id, accountId } })),
    onError: (error) => toastMutationError(error, "The member was not removed"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.workspaceMembers(id) }),
  });
}
