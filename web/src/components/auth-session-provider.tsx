import { lazy, Suspense, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { apiClient, setSessionAuthenticationFailureHandler } from "#/lib/api/client.ts";
import { useAuthSessionStore } from "#/stores/auth-session.ts";

const WelcomeLoginModal = lazy(() =>
  import("#/features/auth/login-modal.tsx").then((module) => ({
    default: module.WelcomeLoginModal,
  })),
);

export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const guestMode = useRouterState({
    select: (state) => /^\/(?:invite|share)\/?$/.test(state.location.pathname),
  });
  const status = useAuthSessionStore((state) => state.status);
  const setAuthenticated = useAuthSessionStore((state) => state.setAuthenticated);
  const setUnauthenticated = useAuthSessionStore((state) => state.setUnauthenticated);

  useEffect(() => {
    window.localStorage.removeItem("aperture-token-vault");
  }, []);

  useEffect(
    () =>
      setSessionAuthenticationFailureHandler(() => {
        queryClient.clear();
        setUnauthenticated();
      }),
    [queryClient, setUnauthenticated],
  );

  useEffect(() => {
    if (guestMode || status !== "loading") {
      return;
    }

    let cancelled = false;
    void apiClient
      .getAuthMe()
      .then((response) => {
        if (!cancelled) {
          setAuthenticated(response);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUnauthenticated();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [guestMode, setAuthenticated, setUnauthenticated, status]);

  return (
    <>
      {children}
      {!guestMode && status === "unauthenticated" ? (
        <Suspense fallback={null}>
          <WelcomeLoginModal open onOpenChange={() => undefined} />
        </Suspense>
      ) : null}
    </>
  );
}
