import { useRouterState } from "@tanstack/react-router";
import { useContext, useEffect, useState } from "react";
import { AppShellFailureContext } from "#/components/app-shell-failure-context.tsx";
import { LazyChunkLoadingFallback, RetryableLazy } from "#/components/retryable-lazy.tsx";
import { SidebarProvider } from "#/components/ui/sidebar-provider.tsx";

let standardAppShellModule:
  | Promise<typeof import("#/components/standard-app-shell.tsx")>
  | undefined;

function loadStandardAppShell() {
  if (!standardAppShellModule) {
    standardAppShellModule = import("#/components/standard-app-shell.tsx").catch(
      (error: unknown) => {
        standardAppShellModule = undefined;
        throw error;
      },
    );
  }

  return standardAppShellModule;
}

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const [mounted, setMounted] = useState(false);
  const shellFailure = useContext(AppShellFailureContext);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isWorkbenchRoute =
    /^\/-\/sessions\/[^/]+\/?$/.test(pathname) || /^\/share\/?$/.test(pathname);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <SidebarProvider
      data-app-shell
      defaultOpen
      className={
        isWorkbenchRoute
          ? "fixed inset-0 h-svh min-h-0 overflow-hidden bg-background"
          : "h-svh min-h-0 overflow-hidden"
      }
    >
      {!mounted ? (
        <div className="fixed inset-0 bg-background" />
      ) : isWorkbenchRoute ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">{children}</div>
      ) : (
        <RetryableLazy
          load={loadStandardAppShell}
          fallback={<LazyChunkLoadingFallback />}
          errorMessage="Unable to load the app shell."
          onError={shellFailure?.onShellError}
          onRetry={shellFailure?.onShellRecovered}
        >
          {(StandardAppShell) => <StandardAppShell>{children}</StandardAppShell>}
        </RetryableLazy>
      )}
    </SidebarProvider>
  );
}
