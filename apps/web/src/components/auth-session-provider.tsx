import { lazy, Suspense, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ApiAuthorization, AuthApi } from "@aperture-browser/api-client";
import { readTemporaryTenant, useAuthSessionStore } from "#/stores/auth-session.ts";
import { toast } from "sonner";
import { useFork } from "@aperture-browser/session-react";

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
  const setTemporaryAuthenticated = useAuthSessionStore((state) => state.setTemporaryAuthenticated);
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
        : Effect.gen(function* () {
            const remembered = yield* AuthApi.use((auth) => auth.getTenantContext());
            const tenantId = readTemporaryTenant(remembered.principal);
            if (tenantId === null) {
              return { auth: remembered, temporary: false };
            }
            return yield* AuthApi.use((auth) => auth.getTenantContext(tenantId)).pipe(
              Effect.map((auth) => ({ auth, temporary: true })),
              Effect.catchTag("ApiRequestError", (error) => {
                if (
                  error.status === 403 ||
                  error.status === 404 ||
                  error.code === "tenant_deactivated"
                ) {
                  toast.warning(
                    "The temporary tenant is no longer available. Returned to your remembered tenant.",
                  );
                  return Effect.succeed({ auth: remembered, temporary: false });
                }
                return Effect.fail(error);
              }),
            );
          }).pipe(
            Effect.match({
              onSuccess: ({ auth, temporary }) =>
                temporary ? setTemporaryAuthenticated(auth) : setAuthenticated(auth),
              onFailure: () => setUnauthenticated(),
            }),
          ),
    [guestMode, setAuthenticated, setTemporaryAuthenticated, setUnauthenticated, status],
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
