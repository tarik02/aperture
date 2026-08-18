import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { apiClient, type UserInput } from "#/lib/api/client.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

function useInvalidateUsers() {
  const queryClient = useQueryClient();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";

  return (userId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["users", profileId] });
    if (userId) {
      void queryClient.invalidateQueries({ queryKey: ["user", profileId, userId] });
    }
  };
}

function useInvalidateMemberships() {
  const queryClient = useQueryClient();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";

  return (userId: string) => {
    void queryClient.invalidateQueries({ queryKey: ["user-memberships", profileId, userId] });
  };
}

export function useCreateUserMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateUsers();

  return useMutation({
    mutationFn: (input: UserInput) => apiClient.createUser(credentials!, input),
    onSuccess: () => invalidate(),
    onError: (error) => toastMutationError(error, "Create failed"),
  });
}

export function useUpdateUserMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateUsers();

  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: UserInput }) =>
      apiClient.updateUser(credentials!, userId, input),
    onSuccess: (user) => invalidate(user.id),
    onError: (error) => toastMutationError(error, "Update failed"),
  });
}

export function useDisableUserMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateUsers();

  return useMutation({
    mutationFn: (userId: string) => apiClient.disableUser(credentials!, userId),
    onSuccess: (user) => invalidate(user.id),
    onError: (error) => toastMutationError(error, "Disable failed"),
  });
}

export function useRestoreUserMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateUsers();

  return useMutation({
    mutationFn: (userId: string) => apiClient.restoreUser(credentials!, userId),
    onSuccess: (user) => invalidate(user.id),
    onError: (error) => toastMutationError(error, "Restore failed"),
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
    }) => apiClient.upsertTenantMembership(credentials!, tenantId, userId, scopes),
    onSuccess: (membership) => invalidate(membership.userId),
    onError: (error) => toastMutationError(error, "Access update failed"),
  });
}

export function useDeleteTenantMembershipMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateMemberships();

  return useMutation({
    mutationFn: async ({ userId, tenantId }: { userId: string; tenantId: string }) => {
      await apiClient.deleteTenantMembership(credentials!, tenantId, userId);
      return { userId };
    },
    onSuccess: ({ userId }) => invalidate(userId),
    onError: (error) => toastMutationError(error, "Access removal failed"),
  });
}
