import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import type { UserInput } from "@aperture/api-client";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { UsersApi } from "@aperture/api-client";
import { useRunApi } from "#/lib/effect/react.tsx";

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
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateUsers();

  return useMutation({
    mutationFn: (input: UserInput) =>
      runApi(UsersApi.use((users) => users.createUser(credentials!, input))),
    onSuccess: () => invalidate(),
    onError: (error) => toastMutationError(error, "Create failed"),
  });
}

export function useUpdateUserMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateUsers();

  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: UserInput }) =>
      runApi(UsersApi.use((users) => users.updateUser(credentials!, userId, input))),
    onSuccess: (user) => invalidate(user.id),
    onError: (error) => toastMutationError(error, "Update failed"),
  });
}

export function useDisableUserMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateUsers();

  return useMutation({
    mutationFn: (userId: string) =>
      runApi(UsersApi.use((users) => users.disableUser(credentials!, userId))),
    onSuccess: (user) => invalidate(user.id),
    onError: (error) => toastMutationError(error, "Disable failed"),
  });
}

export function useRestoreUserMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateUsers();

  return useMutation({
    mutationFn: (userId: string) =>
      runApi(UsersApi.use((users) => users.restoreUser(credentials!, userId))),
    onSuccess: (user) => invalidate(user.id),
    onError: (error) => toastMutationError(error, "Restore failed"),
  });
}

export function useCreateUserInvitationMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();

  return useMutation({
    mutationFn: (userId: string) =>
      runApi(UsersApi.use((users) => users.createUserInvitation(credentials!, userId))),
    onError: (error) => toastMutationError(error, "Password link creation failed"),
  });
}

export function useUpsertTenantMembershipMutation() {
  const runApi = useRunApi();
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
    }) =>
      runApi(
        UsersApi.use((users) =>
          users.upsertTenantMembership(credentials!, tenantId, userId, scopes),
        ),
      ),
    onSuccess: (membership) => invalidate(membership.userId),
    onError: (error) => toastMutationError(error, "Access update failed"),
  });
}

export function useDeleteTenantMembershipMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateMemberships();

  return useMutation({
    mutationFn: async ({ userId, tenantId }: { userId: string; tenantId: string }) => {
      await runApi(
        UsersApi.use((users) => users.deleteTenantMembership(credentials!, tenantId, userId)),
      );
      return { userId };
    },
    onSuccess: ({ userId }) => invalidate(userId),
    onError: (error) => toastMutationError(error, "Access removal failed"),
  });
}
