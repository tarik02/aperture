import { Toaster } from "@aperture-browser/ui/components/sonner";
import { TooltipProvider } from "@aperture-browser/ui/components/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { onSignChange } from "#/lib/sign.ts";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );

  // Whoever is signed in is another, or nobody: nothing asked for the one before is kept.
  useEffect(
    () =>
      onSignChange(() => {
        queryClient.getMutationCache().clear();
        void queryClient.resetQueries();
      }),
    [queryClient],
  );

  return (
    <ThemeProvider
      attribute="class"
      value={{ dark: "aperture-dark" }}
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {children}
          <Toaster richColors closeButton position="bottom-center" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
