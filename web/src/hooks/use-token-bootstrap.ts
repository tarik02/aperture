import { useCallback } from "react";
import { toast } from "sonner";
import {
  selectActiveProfile,
  useTokenVaultStore,
  type TokenProfile,
} from "#/stores/token-vault.ts";

let tokenBootstrapModule: Promise<typeof import("#/lib/token-bootstrap.ts")> | undefined;

function loadTokenBootstrap() {
  if (!tokenBootstrapModule) {
    tokenBootstrapModule = import("#/lib/token-bootstrap.ts").catch((error: unknown) => {
      tokenBootstrapModule = undefined;
      throw error;
    });
  }

  return tokenBootstrapModule;
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
        const { bootstrapTokenProfile } = await loadTokenBootstrap();
        return await bootstrapTokenProfile({
          profile,
          applyBootstrap,
          clearBootstrapMetadata,
          touchProfile,
        });
      } catch {
        clearBootstrapMetadata(profile.id);
        toast.error("Token validation failed");
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
