import { useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { SidebarProvider } from "#/components/ui/sidebar-provider.tsx";

const StandardAppShell = lazy(() => import("#/components/standard-app-shell.tsx"));

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const [mounted, setMounted] = useState(false);
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
        <Suspense fallback={<div className="fixed inset-0 bg-background" />}>
          <StandardAppShell>{children}</StandardAppShell>
        </Suspense>
      )}
    </SidebarProvider>
  );
}
