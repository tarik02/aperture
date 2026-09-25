import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { AuthSessionProvider } from "#/components/auth-session-provider.tsx";
import { PwaRegistration } from "#/components/pwa-registration.tsx";
import { Toaster } from "@aperture-browser/ui/components/sonner";
import { TooltipProvider } from "@aperture-browser/ui/components/tooltip";
import { WindowControlsOverlayWatcher } from "#/features/window-controls-overlay/window-controls-overlay-watcher.tsx";
import { makeApertureRuntime, RuntimeProvider } from "@aperture-browser/session-react";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  // Lives as long as the page; nothing to dispose on unmount.
  const [runtime] = useState(() => makeApertureRuntime());

  return (
    <RuntimeProvider runtime={runtime}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <QueryClientProvider client={queryClient}>
          <HotkeysProvider>
            <TooltipProvider>
              <WindowControlsOverlayWatcher />
              <AuthSessionProvider>{children}</AuthSessionProvider>
              <PwaRegistration />
              <Toaster richColors closeButton position="bottom-center" />
            </TooltipProvider>
          </HotkeysProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </RuntimeProvider>
  );
}
