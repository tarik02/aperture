import { useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { SidebarProvider } from "@aperture-browser/ui/components/sidebar-provider";

const StandardAppShell = lazy(() => import("#/components/standard-app-shell.tsx"));

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const [mounted, setMounted] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isWorkbenchRoute =
    /^\/-\/sessions\/[^/]+\/?$/.test(pathname) ||
    /^\/(?:invite|share|oauth\/consent)\/?$/.test(pathname);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <SidebarProvider
      data-app-shell
      defaultOpen
      className={
        isWorkbenchRoute
          ? "aperture:fixed aperture:inset-0 aperture:h-svh aperture:min-h-0 aperture:overflow-hidden aperture:bg-background"
          : "aperture:h-svh aperture:min-h-0 aperture:overflow-hidden"
      }
    >
      {!mounted ? (
        <div className="aperture:fixed aperture:inset-0 aperture:bg-background" />
      ) : isWorkbenchRoute ? (
        <div className="aperture:flex aperture:min-h-0 aperture:flex-1 aperture:flex-col aperture:overflow-hidden aperture:bg-background">
          {children}
        </div>
      ) : (
        <Suspense
          fallback={<div className="aperture:fixed aperture:inset-0 aperture:bg-background" />}
        >
          <StandardAppShell>{children}</StandardAppShell>
        </Suspense>
      )}
    </SidebarProvider>
  );
}
