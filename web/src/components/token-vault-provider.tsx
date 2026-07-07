import { useEffect } from "react";
import { WelcomeTokenAuthModal } from "#/features/token/auth-modal/token-auth-modal.tsx";
import { useTokenBootstrap } from "#/hooks/use-token-bootstrap.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

export function TokenVaultProvider({ children }: { children: React.ReactNode }) {
  const hydrated = useTokenVaultStore((state) => state.hydrated);
  const profiles = useTokenVaultStore((state) => state.profiles);
  const activeProfileId = useTokenVaultStore((state) => state.activeProfileId);
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const { bootstrapProfileById } = useTokenBootstrap();

  const needsWelcome = hydrated && profiles.length === 0;

  useEffect(() => {
    if (!hydrated || !activeProfileId) {
      return;
    }

    void bootstrapProfileById(activeProfileId);
  }, [activeProfile?.selectedTenantId, activeProfileId, bootstrapProfileById, hydrated]);

  return (
    <>
      {children}
      <WelcomeTokenAuthModal open={needsWelcome} onOpenChange={() => undefined} />
    </>
  );
}

export function useActiveTokenProfile() {
  return useTokenVaultStore(selectActiveProfile);
}

export function useTokenVaultReady() {
  const hydrated = useTokenVaultStore((state) => state.hydrated);
  const profiles = useTokenVaultStore((state) => state.profiles);
  const activeProfile = useTokenVaultStore(selectActiveProfile);

  return hydrated && profiles.length > 0 && activeProfile !== null;
}
