import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "#/lib/api/client.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

function useInvalidateTenants() {
  const queryClient = useQueryClient();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";

  return () => {
    void queryClient.invalidateQueries({ queryKey: ["tenants", profileId] });
  };
}

export function useCreateTenantMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTenants();

  return useMutation({
    mutationFn: (input: { displayName: string }) => apiClient.createTenant(credentials!, input),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Create failed"),
  });
}

export function useUpdateTenantMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTenants();

  return useMutation({
    mutationFn: ({ tenantId, displayName }: { tenantId: string; displayName: string }) =>
      apiClient.updateTenant(credentials!, tenantId, { displayName }),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Update failed"),
  });
}

export function useDeleteTenantMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTenants();

  return useMutation({
    mutationFn: (tenantId: string) => apiClient.deleteTenant(credentials!, tenantId),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Delete failed"),
  });
}

export function useRestoreTenantMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTenants();

  return useMutation({
    mutationFn: (tenantId: string) => apiClient.restoreTenant(credentials!, tenantId),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Restore failed"),
  });
}
