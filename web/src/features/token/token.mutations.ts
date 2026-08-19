import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  apiClient,
  type CreateAdminTokenInput,
  type CreateTenantTokenInput,
} from "#/lib/api/client.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

export type CreateTokenMutationInput =
  | { kind: "admin"; input: CreateAdminTokenInput }
  | { kind: "tenant"; input: CreateTenantTokenInput };

function useInvalidateTokens() {
  const queryClient = useQueryClient();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const profileId = activeProfile?.id ?? "none";

  return () => {
    void queryClient.invalidateQueries({ queryKey: ["tokens", profileId] });
  };
}

export function useCreateTokenMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTokens();

  return useMutation({
    mutationFn: (request: CreateTokenMutationInput) => {
      switch (request.kind) {
        case "admin":
          return apiClient.createAdminToken(credentials!, request.input);
        case "tenant":
          return apiClient.createTenantToken(credentials!, request.input);
        default: {
          const exhaustive: never = request;
          return exhaustive;
        }
      }
    },
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Create failed"),
  });
}

export function useRevokeTokenMutation() {
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTokens();

  return useMutation({
    mutationFn: (tokenId: string) => {
      if (credentials!.authorityType === "system_admin") {
        return apiClient.revokeAdminToken(credentials!, tokenId);
      }
      return apiClient.revokeTenantToken(credentials!, tokenId);
    },
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Revoke failed"),
  });
}
