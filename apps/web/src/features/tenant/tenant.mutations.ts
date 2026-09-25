import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { TenantsApi } from "@aperture-browser/api-client";
import { useRunApi } from "#/lib/effect/react.tsx";

function useInvalidateTenants() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["tenants"] });
  };
}

export function useCreateTenantMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTenants();

  return useMutation({
    mutationFn: (input: { displayName: string }) =>
      runApi(TenantsApi.use((tenants) => tenants.createTenant(credentials!, input))),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Create failed"),
  });
}

export function useUpdateTenantMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTenants();

  return useMutation({
    mutationFn: ({ tenantId, displayName }: { tenantId: string; displayName: string }) =>
      runApi(
        TenantsApi.use((tenants) => tenants.updateTenant(credentials!, tenantId, { displayName })),
      ),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Update failed"),
  });
}

export function useDeleteTenantMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTenants();

  return useMutation({
    mutationFn: (tenantId: string) =>
      runApi(TenantsApi.use((tenants) => tenants.deleteTenant(credentials!, tenantId))),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Delete failed"),
  });
}

export function useRestoreTenantMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTenants();

  return useMutation({
    mutationFn: (tenantId: string) =>
      runApi(TenantsApi.use((tenants) => tenants.restoreTenant(credentials!, tenantId))),
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Restore failed"),
  });
}
