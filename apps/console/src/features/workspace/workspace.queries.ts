import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccess } from "#/features/auth/access.ts";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import {
  selectWorkspace,
  useSelectedWorkspaceId,
  useShowsEveryWorkspace,
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

/**
 * The workspaces to choose among: those the account is in, and for an admin who asked for
 * them, the rest as well. One that is selected is among them, whatever it is.
 */
export function useShownWorkspaces() {
  const workspaces = useWorkspacesQuery();
  const selected = useSelectedWorkspaceId();
  const offersEvery = useAccess().may("admin");
  const showsEvery = useShowsEveryWorkspace() && offersEvery;
  const all = workspaces.data ?? [];
  return {
    workspaces,
    /** Whether there are workspaces the account is not in to be shown. */
    offersEvery: offersEvery && all.some((workspace) => workspace.role === null),
    showsEvery,
    joined: all.filter((workspace) => workspace.role !== null),
    others: all.filter(
      (workspace) => workspace.role === null && (showsEvery || workspace.id === selected),
    ),
  };
}

/**
 * Whether what is of a workspace is only looked at: an admin sees what is in a workspace
 * they are not in, and acts there once they join it.
 */
export function useOnlooks() {
  const workspaces = useWorkspacesQuery().data;
  return (workspaceId: string | null) =>
    workspaceId !== null &&
    workspaces?.find((workspace) => workspace.id === workspaceId)?.role === null;
}

/** An admin puts themselves into a workspace, to act in it. */
export function useJoinWorkspaceMutation() {
  const queries = useQueryClient();
  const account = useAccountQuery().data;
  return useMutation({
    mutationFn: (id: string) =>
      call((api) =>
        api.workspaces.admit({
          params: { id, accountId: account?.id ?? "" },
          payload: { role: "member" },
        }),
      ),
    onError: (error) => toastMutationError(error, "The workspace was not joined"),
    onSettled: (_, __, id) =>
      Promise.all([
        queries.invalidateQueries({ queryKey: queryKeys.workspaces }),
        queries.invalidateQueries({ queryKey: queryKeys.workspaceMembers(id) }),
      ]),
  });
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

export function useRenameWorkspaceMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (workspace: { id: string; name: string }) =>
      call((api) =>
        api.workspaces.rename({ params: { id: workspace.id }, payload: { name: workspace.name } }),
      ),
    onError: (error) => toastMutationError(error, "The workspace was not renamed"),
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
