import { lazy, Suspense, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Effect, Stream } from "effect";
import { ApiAuthorization, AuthApi } from "@aperture/api-client";
import { useAuthSessionStore } from "#/stores/auth-session.ts";
import { useFork } from "#/lib/effect/react.tsx";

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

  useFork(
    () =>
      ApiAuthorization.use((authorization) =>
        Stream.runForEach(authorization.sessionAuthenticationFailures, () =>
          Effect.sync(() => {
            queryClient.clear();
            setUnauthenticated();
          }),
        ),
      ),
    [queryClient, setUnauthenticated],
  );

  // Interrupted when the status changes first, so a stale answer is never applied.
  useFork(
    () =>
      guestMode || status !== "loading"
        ? undefined
        : AuthApi.use((auth) => auth.getAuthMe()).pipe(
            Effect.match({
              onSuccess: setAuthenticated,
              onFailure: () => setUnauthenticated(),
            }),
          ),
    [guestMode, setAuthenticated, setUnauthenticated, status],
  );

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
