import { useCallback } from "react";
import { toast } from "sonner";
import { ApiRequestError } from "#/lib/api/errors.ts";
import { fetchAuthMe } from "#/lib/auth-me.ts";
import {
  selectActiveProfile,
  useTokenVaultStore,
  type TokenProfile,
} from "#/stores/token-vault.ts";

function bootstrapErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Token validation failed";
}

export function useTokenBootstrap() {
  const setBootstrapping = useTokenVaultStore((state) => state.setBootstrapping);
  const applyBootstrap = useTokenVaultStore((state) => state.applyBootstrap);
  const clearBootstrapMetadata = useTokenVaultStore((state) => state.clearBootstrapMetadata);
  const touchProfile = useTokenVaultStore((state) => state.touchProfile);

  const bootstrapProfile = useCallback(
    async (profile: TokenProfile): Promise<boolean> => {
      setBootstrapping(true);

      try {
        const selectedTenantId =
          profile.credentialType === "web_session" || profile.authorityType === "system_admin"
            ? profile.selectedTenantId
            : null;
        const response = await fetchAuthMe(
          profile.credentialType === "api_token" ? profile.rawToken : null,
          selectedTenantId,
        );
        applyBootstrap(profile.id, response);
        touchProfile(profile.id);
        return true;
      } catch (error) {
        clearBootstrapMetadata(profile.id);
        toast.error(bootstrapErrorMessage(error));
        return false;
      } finally {
        setBootstrapping(false);
      }
    },
    [applyBootstrap, clearBootstrapMetadata, setBootstrapping, touchProfile],
  );

  const bootstrapProfileById = useCallback(
    async (profileId: string): Promise<boolean> => {
      const profile = useTokenVaultStore
        .getState()
        .profiles.find((entry) => entry.id === profileId);
      if (!profile) {
        return false;
      }

      return bootstrapProfile(profile);
    },
    [bootstrapProfile],
  );

  const bootstrapActiveProfile = useCallback(async (): Promise<boolean> => {
    const profile = selectActiveProfile(useTokenVaultStore.getState());
    if (!profile) {
      return false;
    }

    return bootstrapProfile(profile);
  }, [bootstrapProfile]);

  return {
    bootstrapProfile,
    bootstrapProfileById,
    bootstrapActiveProfile,
  };
}
