import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@aperture-browser/ui/components/sidebar";
import { useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { AppSidebar } from "#/components/app-sidebar.tsx";
import { PageHeaderActionsTarget } from "#/components/page-header-actions.tsx";
import { resolveNavItem } from "#/lib/navigation.ts";

type AppShellProps = {
  /** A page gets the title bar; the workbench brings its own and only shares the sidebar. */
  layout: "page" | "workbench";
  children: React.ReactNode;
};

/** As tall as the window and no taller: what is inside scrolls, and fills what it does not. */
const FILLS = "aperture:h-svh";

export function AppShell({ layout, children }: AppShellProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(null);

  if (layout === "workbench") {
    return (
      <SidebarProvider key="workbench" defaultOpen={false} className={FILLS}>
        <AppSidebar collapsible="offcanvas" />
        <SidebarInset className="aperture:h-full aperture:min-h-0 aperture:overflow-hidden">
          {children}
        </SidebarInset>
      </SidebarProvider>
    );
  }

  return (
    <SidebarProvider key="page" className={FILLS}>
      <AppSidebar collapsible="icon" />
      <SidebarInset className="aperture:h-full aperture:min-h-0 aperture:overflow-hidden">
        <header className="aperture:flex aperture:h-12 aperture:shrink-0 aperture:items-center aperture:gap-2 aperture:border-b aperture:px-3">
          <SidebarTrigger className="aperture:-ml-1" />
          <h1 className="aperture:shrink-0 aperture:truncate aperture:pr-2 aperture:text-sm aperture:font-semibold aperture:max-sm:sr-only">
            {resolveNavItem(pathname)?.title ?? "Sessions"}
          </h1>
          <div
            ref={setHeaderActions}
            className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:justify-end aperture:gap-2"
          />
        </header>
        <div className="aperture:relative aperture:min-h-0 aperture:flex-1">
          <PageHeaderActionsTarget.Provider value={headerActions}>
            {children}
          </PageHeaderActionsTarget.Provider>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
