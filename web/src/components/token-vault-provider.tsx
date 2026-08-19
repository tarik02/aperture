import { lazy, Suspense, useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useTokenBootstrap } from "#/hooks/use-token-bootstrap.ts";
import { fetchAuthMe } from "#/lib/auth-me.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

const WelcomeTokenAuthModal = lazy(() =>
  import("#/features/token/auth-modal/token-auth-modal.tsx").then((module) => ({
    default: module.WelcomeTokenAuthModal,
  })),
);

export function TokenVaultProvider({ children }: { children: React.ReactNode }) {
  const guestMode = useRouterState({
    select: (state) => /^\/(?:invite|share)\/?$/.test(state.location.pathname),
  });
  const hydrated = useTokenVaultStore((state) => state.hydrated);
  const profiles = useTokenVaultStore((state) => state.profiles);
  const activeProfileId = useTokenVaultStore((state) => state.activeProfileId);
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const upsertWebSession = useTokenVaultStore((state) => state.upsertWebSession);
  const removeProfile = useTokenVaultStore((state) => state.removeProfile);
  const { bootstrapProfileById } = useTokenBootstrap();
  const [webSessionChecked, setWebSessionChecked] = useState(false);

  const authReady = guestMode || webSessionChecked;
  const needsWelcome = hydrated && authReady && profiles.length === 0;

  useEffect(() => {
    if (guestMode || !hydrated || webSessionChecked) {
      return;
    }

    let cancelled = false;
    void fetchAuthMe(null)
      .then((response) => {
        if (!cancelled) {
          upsertWebSession(response);
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        for (const profile of useTokenVaultStore.getState().profiles) {
          if (profile.credentialType === "web_session") {
            removeProfile(profile.id);
          }
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWebSessionChecked(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [guestMode, hydrated, removeProfile, upsertWebSession, webSessionChecked]);

  useEffect(() => {
    if (guestMode || !hydrated || !authReady || !activeProfileId) {
      return;
    }

    void bootstrapProfileById(activeProfileId);
  }, [
    activeProfile?.selectedTenantId,
    activeProfileId,
    authReady,
    bootstrapProfileById,
    guestMode,
    hydrated,
  ]);

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
