import { lazy, Suspense, useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useTokenBootstrap } from "#/hooks/use-token-bootstrap.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

const WelcomeTokenAuthModal = lazy(() =>
  import("#/features/token/auth-modal/token-auth-modal.tsx").then((module) => ({
    default: module.WelcomeTokenAuthModal,
  })),
);

export function TokenVaultProvider({ children }: { children: React.ReactNode }) {
  const guestMode = useRouterState({
    select: (state) => /^\/share\/?$/.test(state.location.pathname),
  });
  const hydrated = useTokenVaultStore((state) => state.hydrated);
  const profiles = useTokenVaultStore((state) => state.profiles);
  const activeProfileId = useTokenVaultStore((state) => state.activeProfileId);
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const { bootstrapProfileById } = useTokenBootstrap();

  const needsWelcome = hydrated && profiles.length === 0;

  useEffect(() => {
    if (guestMode || !hydrated || !activeProfileId) {
      return;
    }

    void bootstrapProfileById(activeProfileId);
  }, [activeProfile?.selectedTenantId, activeProfileId, bootstrapProfileById, guestMode, hydrated]);

  return (
    <>
      {children}
      {!guestMode && needsWelcome ? (
        <Suspense fallback={null}>
          <WelcomeTokenAuthModal open onOpenChange={() => undefined} />
        </Suspense>
      ) : null}
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
