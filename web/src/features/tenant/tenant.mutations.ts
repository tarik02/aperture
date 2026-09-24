import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { runApi } from "#/lib/runtime.ts";

function useInvalidateTenants() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["tenants"] });
  };
}

export function useCreateTenantMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTenants();

  return useMutation({
    mutationFn: (input: { displayName: string }) =>
      runApi((api) => api.createTenant(credentials!, input)),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Create failed"),
  });
}

export function useUpdateTenantMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTenants();

  return useMutation({
    mutationFn: ({ tenantId, displayName }: { tenantId: string; displayName: string }) =>
      runApi((api) => api.updateTenant(credentials!, tenantId, { displayName })),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Update failed"),
  });
}

export function useDeleteTenantMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTenants();

  return useMutation({
    mutationFn: (tenantId: string) => runApi((api) => api.deleteTenant(credentials!, tenantId)),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Delete failed"),
  });
}

export function useRestoreTenantMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTenants();

  return useMutation({
    mutationFn: (tenantId: string) => runApi((api) => api.restoreTenant(credentials!, tenantId)),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Restore failed"),
  });
}
