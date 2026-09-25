import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type CreateAdminTokenInput,
  type CreateTenantTokenInput,
} from "@aperture-browser/api-client";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { TokensApi } from "@aperture-browser/api-client";
import { useRunApi } from "#/lib/effect/react.tsx";

export type CreateTokenMutationInput =
  | { kind: "admin"; input: CreateAdminTokenInput }
  | { kind: "tenant"; input: CreateTenantTokenInput };

function useInvalidateTokens() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["tokens"] });
  };
}

export function useCreateTokenMutation() {
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTokens();

  return useMutation({
    mutationFn: (request: CreateTokenMutationInput) => {
      switch (request.kind) {
        case "admin":
          return runApi(
            TokensApi.use((tokens) => tokens.createAdminToken(credentials!, request.input)),
          );
        case "tenant":
          return runApi(
            TokensApi.use((tokens) => tokens.createTenantToken(credentials!, request.input)),
          );
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
  const runApi = useRunApi();
  const credentials = useApiCredentials();
  const invalidate = useInvalidateTokens();

  return useMutation({
    mutationFn: (tokenId: string) => {
      if (credentials!.authorityType === "system_admin") {
        return runApi(TokensApi.use((tokens) => tokens.revokeAdminToken(credentials!, tokenId)));
      }
      return runApi(TokensApi.use((tokens) => tokens.revokeTenantToken(credentials!, tokenId)));
    },
    onSuccess: invalidate,
    onError: (error) => toastMutationError(error, "Revoke failed"),
  });
}
