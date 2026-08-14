import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useMemo, useState } from "react";
import { AppShellFailureContext } from "#/components/app-shell-failure-context.tsx";
import { LazyChunkLoadingFallback, RetryableLazy } from "#/components/retryable-lazy.tsx";
import { TokenVaultProvider } from "#/components/token-vault-provider.tsx";
import { PwaRegistration } from "#/components/pwa-registration.tsx";
import { Toaster } from "#/components/ui/sonner.tsx";
import { WindowControlsOverlayWatcher } from "#/features/window-controls-overlay/window-controls-overlay-watcher.tsx";

let tooltipProviderModule: Promise<typeof import("#/components/ui/tooltip.tsx")> | undefined;

function loadTooltipProvider() {
  if (!tooltipProviderModule) {
    tooltipProviderModule = import("#/components/ui/tooltip.tsx").catch((error: unknown) => {
      tooltipProviderModule = undefined;
      throw error;
    });
  }

  return tooltipProviderModule.then(({ TooltipProvider }) => ({
    default: TooltipProvider,
  }));
}

function ClientTooltipProvider({
  children,
  onError,
  onRecovered,
}: {
  children: React.ReactNode;
  onError: () => void;
  onRecovered: () => void;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return children;
  }

  return (
    <RetryableLazy
      load={loadTooltipProvider}
      fallback={<LazyChunkLoadingFallback />}
      errorMessage="Unable to load tooltips."
      onError={onError}
      onRetry={onRecovered}
    >
      {(TooltipProvider) => <TooltipProvider>{children}</TooltipProvider>}
    </RetryableLazy>
  );
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <HotkeysProvider>
          <AppContent>{children}</AppContent>
        </HotkeysProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function AppContent({ children }: { children: React.ReactNode }) {
  const [tooltipChunkFailed, setTooltipChunkFailed] = useState(false);
  const [shellLoaderFailed, setShellLoaderFailed] = useState(false);
  const [routeChunkFailed, setRouteChunkFailed] = useState(false);
  const shellFailure = useMemo(
    () => ({
      onShellError: () => setShellLoaderFailed(true),
      onShellRecovered: () => setShellLoaderFailed(false),
      onRouteError: () => setRouteChunkFailed(true),
    }),
    [],
  );

  return (
    <AppShellFailureContext.Provider value={shellFailure}>
      <WindowControlsOverlayWatcher />
      <TokenVaultProvider
        suppressWelcome={tooltipChunkFailed || shellLoaderFailed || routeChunkFailed}
      >
        <ClientTooltipProvider
          onError={() => setTooltipChunkFailed(true)}
          onRecovered={() => setTooltipChunkFailed(false)}
        >
          {children}
        </ClientTooltipProvider>
      </TokenVaultProvider>
      <PwaRegistration />
      <Toaster richColors closeButton position="bottom-center" />
    </AppShellFailureContext.Provider>
  );
}
