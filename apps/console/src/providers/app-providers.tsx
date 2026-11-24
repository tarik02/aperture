import { Toaster } from "@aperture-browser/ui/components/sonner";
import { TooltipProvider } from "@aperture-browser/ui/components/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { NotAnsweringNotice } from "#/components/not-answering.tsx";
import { notAnswering, watchAnswering } from "#/lib/answering.ts";
import { onSignChange } from "#/lib/sign.ts";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            // What Aperture did not answer is asked again after a pause, and not by whatever
            // comes to show it: a page that shows nothing while it is asked, and something
            // that asks once it failed, would ask without end.
            retryOnMount: (query) => !notAnswering(query.state.error),
          },
        },
      }),
  );

  useEffect(() => watchAnswering(queryClient), [queryClient]);

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
          <NotAnsweringNotice />
          <Toaster richColors closeButton position="bottom-center" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
