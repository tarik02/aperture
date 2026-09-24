import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import type { UserInput } from "@aperture/api-client";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { runApi } from "#/lib/runtime.ts";

function useInvalidateUsers() {
  const queryClient = useQueryClient();
  return (userId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["users"] });
    if (userId) {
      void queryClient.invalidateQueries({ queryKey: ["user", userId] });
    }
  };
}

function useInvalidateMemberships() {
  const queryClient = useQueryClient();
  return (userId: string) => {
    void queryClient.invalidateQueries({ queryKey: ["user-memberships", userId] });
  };
}

export function useCreateUserMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateUsers();

  return useMutation({
    mutationFn: (input: UserInput) => runApi((api) => api.createUser(credentials!, input)),
    onSuccess: () => invalidate(),
    onError: (error) => toastMutationError(error, "Create failed"),
  });
}

export function useUpdateUserMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateUsers();

  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: UserInput }) =>
      runApi((api) => api.updateUser(credentials!, userId, input)),
    onSuccess: (user) => invalidate(user.id),
    onError: (error) => toastMutationError(error, "Update failed"),
  });
}

export function useDisableUserMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateUsers();

  return useMutation({
    mutationFn: (userId: string) => runApi((api) => api.disableUser(credentials!, userId)),
    onSuccess: (user) => invalidate(user.id),
    onError: (error) => toastMutationError(error, "Disable failed"),
  });
}

export function useRestoreUserMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateUsers();

  return useMutation({
    mutationFn: (userId: string) => runApi((api) => api.restoreUser(credentials!, userId)),
    onSuccess: (user) => invalidate(user.id),
    onError: (error) => toastMutationError(error, "Restore failed"),
  });
}

export function useCreateUserInvitationMutation() {
  const credentials = useApiCredentials();

  return useMutation({
    mutationFn: (userId: string) => runApi((api) => api.createUserInvitation(credentials!, userId)),
    onError: (error) => toastMutationError(error, "Password link creation failed"),
  });
}

export function useUpsertTenantMembershipMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateMemberships();

  return useMutation({
    mutationFn: ({
      userId,
      tenantId,
      scopes,
    }: {
      userId: string;
      tenantId: string;
      scopes: string[];
    }) => runApi((api) => api.upsertTenantMembership(credentials!, tenantId, userId, scopes)),
    onSuccess: (membership) => invalidate(membership.userId),
    onError: (error) => toastMutationError(error, "Access update failed"),
  });
}

export function useDeleteTenantMembershipMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateMemberships();

  return useMutation({
    mutationFn: async ({ userId, tenantId }: { userId: string; tenantId: string }) => {
      await runApi((api) => api.deleteTenantMembership(credentials!, tenantId, userId));
      return { userId };
    },
    onSuccess: ({ userId }) => invalidate(userId),
    onError: (error) => toastMutationError(error, "Access removal failed"),
  });
}
