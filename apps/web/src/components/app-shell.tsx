import { useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { SidebarProvider } from "@aperture-browser/ui/components/sidebar-provider";
import { searchFlag } from "#/lib/search-flag.ts";
import { useSidebarStore, type SidebarLayout } from "#/stores/sidebar.ts";

const StandardAppShell = lazy(() => import("#/components/standard-app-shell.tsx"));

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const [mounted, setMounted] = useState(false);
  const location = useRouterState({ select: (state) => state.location });
  const layout = shellLayout(location.pathname, location.search);
  const sidebarOpen = useSidebarStore((state) => (layout === "bare" ? false : state.open[layout]));
  const setSidebarOpen = useSidebarStore((state) => state.setOpen);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <SidebarProvider
      data-app-shell
      open={sidebarOpen}
      onOpenChange={(open) => {
        if (layout !== "bare") {
          setSidebarOpen(layout, open);
        }
      }}
      className={
        layout === "page"
          ? "aperture:h-svh aperture:min-h-0 aperture:overflow-hidden"
          : "aperture:fixed aperture:inset-0 aperture:h-svh aperture:min-h-0 aperture:overflow-hidden aperture:bg-background"
      }
    >
      {!mounted ? (
        <div className="aperture:fixed aperture:inset-0 aperture:bg-background" />
      ) : layout === "bare" ? (
        <div className="aperture:flex aperture:min-h-0 aperture:flex-1 aperture:flex-col aperture:overflow-hidden aperture:bg-background">
          {children}
        </div>
      ) : (
        <Suspense
          fallback={<div className="aperture:fixed aperture:inset-0 aperture:bg-background" />}
        >
          <StandardAppShell layout={layout}>{children}</StandardAppShell>
        </Suspense>
      )}
    </SidebarProvider>
  );
}

/**
 * Standalone pages and an embedded workbench render without app chrome; the workbench shares the
 * app sidebar but keeps its own open state for it.
 */
function shellLayout(pathname: string, search: object): SidebarLayout | "bare" {
  if (/^\/(?:invite|share|oauth\/consent)\/?$/.test(pathname)) {
    return "bare";
  }
  if (/^\/-\/sessions\/[^/]+\/?$/.test(pathname)) {
    return searchFlag((search as { embed?: unknown }).embed) ? "bare" : "workbench";
  }
  return "page";
}
