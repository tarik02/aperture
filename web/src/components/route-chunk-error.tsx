import { useContext, useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { AppShellFailureContext } from "#/components/app-shell-failure-context.tsx";
import { resetRouteComponentFailures } from "#/lib/retryable-route-component.ts";

export function RouteChunkError() {
  const router = useRouter();
  const shellFailure = useContext(AppShellFailureContext);
  const retryButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    shellFailure?.onRouteError();
  }, [shellFailure]);

  const retry = () => {
    resetRouteComponentFailures();
    for (const route of Object.values(router.routesById)) {
      route._componentsPromise = undefined;
      route._componentsLoaded = false;
    }
    retryButton.current?.focus();
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background p-6">
      <div role="alert" className="max-w-sm space-y-4 text-center">
        <p>Unable to load this page.</p>
        <button
          type="button"
          autoFocus
          ref={retryButton}
          className="rounded-md border px-3 py-2 text-sm font-medium"
          onClick={retry}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
