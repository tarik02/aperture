import { useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useLayoutEffect, useState } from "react";
import { SidebarProvider } from "@aperture-browser/ui/components/sidebar-provider";
import { WindowControlsOverlayWatcher } from "#/features/window-controls-overlay/window-controls-overlay-watcher.tsx";
import { shellLayout } from "#/lib/shell-layout.ts";
import { useSidebarStore } from "#/stores/sidebar.ts";

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
  // The shell is prerendered for the launcher, so the first client render has to keep the page
  // chrome and only switch to the route's layout once hydrated.
  const chromeLayout = mounted ? layout : "page";
  // The window controls depend on the layout and the sidebar, so they live with this state.
  const sidebarCollapsible =
    chromeLayout === "bare" ? undefined : chromeLayout === "workbench" ? "offcanvas" : "icon";
  const chromeSidebarOpen = mounted ? sidebarOpen : true;

  useLayoutEffect(() => {
    setMounted(true);
  }, []);

  return (
    <SidebarProvider
      data-app-shell
      data-sidebar-collapsible={sidebarCollapsible}
      data-sidebar-open={sidebarCollapsible === undefined ? undefined : chromeSidebarOpen}
      open={chromeSidebarOpen}
      onOpenChange={(open) => {
        if (layout !== "bare") {
          setSidebarOpen(layout, open);
        }
      }}
      className={
        chromeLayout === "page"
          ? "aperture:h-svh aperture:min-h-0 aperture:overflow-hidden"
          : "aperture:fixed aperture:inset-0 aperture:h-svh aperture:min-h-0 aperture:overflow-hidden aperture:bg-background"
      }
    >
      <WindowControlsOverlayWatcher layout={layout} />
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
