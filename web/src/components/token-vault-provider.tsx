import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { RetryableLazy } from "#/components/retryable-lazy.tsx";
import { useTokenBootstrap } from "#/hooks/use-token-bootstrap.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

let welcomeTokenAuthModalModule:
  | Promise<typeof import("#/features/token/auth-modal/token-auth-modal.tsx")>
  | undefined;

function loadWelcomeTokenAuthModal() {
  if (!welcomeTokenAuthModalModule) {
    welcomeTokenAuthModalModule = import("#/features/token/auth-modal/token-auth-modal.tsx").catch(
      (error: unknown) => {
        welcomeTokenAuthModalModule = undefined;
        throw error;
      },
    );
  }

  return welcomeTokenAuthModalModule.then(({ WelcomeTokenAuthModal }) => ({
    default: WelcomeTokenAuthModal,
  }));
}

export function TokenVaultProvider({
  children,
  suppressWelcome = false,
}: {
  children: React.ReactNode;
  suppressWelcome?: boolean;
}) {
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
      {!suppressWelcome && !guestMode && needsWelcome ? (
        <RetryableLazy
          load={loadWelcomeTokenAuthModal}
          fallback={null}
          errorMessage="Unable to load the sign-in form."
        >
          {(WelcomeTokenAuthModal) => <WelcomeTokenAuthModal open onOpenChange={() => undefined} />}
        </RetryableLazy>
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
