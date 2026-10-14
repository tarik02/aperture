import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import type { CreateUserInput, UserInput } from "@aperture-browser/api-client";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { UsersApi } from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";

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
    mutationFn: (input: CreateUserInput) =>
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

export function useCreatePersonalTenantMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const queryClient = useQueryClient();
  const invalidateUsers = useInvalidateUsers();

  return useMutation({
    mutationFn: (userId: string) =>
      runApi(UsersApi.use((users) => users.createPersonalTenant(credentials!, userId))),
    onSuccess: (_result, userId) => {
      invalidateUsers(userId);
      // An administrator's tenant list shows their own personal tenant.
      void queryClient.invalidateQueries({ queryKey: ["tenants"] });
    },
    onError: (error) => toastMutationError(error, "Personal tenant creation failed"),
  });
}

export function useDeletePersonalTenantMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const queryClient = useQueryClient();
  const invalidateUsers = useInvalidateUsers();

  return useMutation({
    mutationFn: (userId: string) =>
      runApi(UsersApi.use((users) => users.deletePersonalTenant(credentials!, userId))),
    onSuccess: (_result, userId) => {
      invalidateUsers(userId);
      void queryClient.invalidateQueries({ queryKey: ["tenants"] });
    },
    onError: (error) => toastMutationError(error, "Personal tenant deletion failed"),
  });
}
