import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { TokenVaultProvider } from "#/components/token-vault-provider.tsx";
import { PwaRegistration } from "#/components/pwa-registration.tsx";
import { Toaster } from "#/components/ui/sonner.tsx";
import { TooltipProvider } from "#/components/ui/tooltip.tsx";
import { WindowControlsOverlayWatcher } from "#/components/window-controls-overlay-watcher.tsx";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <HotkeysProvider>
          <TooltipProvider>
            <WindowControlsOverlayWatcher />
            <TokenVaultProvider>{children}</TokenVaultProvider>
            <PwaRegistration />
            <Toaster richColors closeButton position="top-right" />
          </TooltipProvider>
        </HotkeysProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
