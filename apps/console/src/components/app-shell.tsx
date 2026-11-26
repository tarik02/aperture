import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@aperture-browser/ui/components/breadcrumb";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@aperture-browser/ui/components/sidebar";
import { cn } from "@aperture-browser/ui/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { AppSidebar } from "#/components/app-sidebar.tsx";
import { SidebarGoesAway } from "#/components/sidebar-goes-away.tsx";
import { PageCrumb } from "#/components/page-crumb.tsx";
import { PageHeaderActionsTarget } from "#/components/page-header-actions.tsx";
import { WindowTitlebar } from "#/components/window-titlebar.tsx";
import { useDocumentTitle } from "#/lib/document-title.ts";
import { resolveNavItem } from "#/lib/navigation.ts";

type AppShellProps = {
  /** A page gets the title bar; the workbench brings its own and only shares the sidebar. */
  layout: "page" | "workbench";
  children: React.ReactNode;
};

/** As tall as the window and no taller: what is inside scrolls, and fills what it does not. */
// Less what the on-screen keyboard covers, where the browser does not take that off itself.
const FILLS = "aperture:h-[calc(100dvh-var(--keyboard-inset,0px))]";

/** Clear of what a phone's screen has at its edges, where the page is laid out under them. */
const INSET =
  "aperture:h-full aperture:min-h-0 aperture:overflow-hidden aperture:pr-[env(safe-area-inset-right)] aperture:pb-[env(safe-area-inset-bottom)] aperture:pl-[env(safe-area-inset-left)]";

const TITLE =
  "aperture:min-w-0 aperture:shrink-0 aperture:truncate aperture:pr-2 aperture:text-sm aperture:font-semibold aperture:max-sm:shrink";

export function AppShell({ layout, children }: AppShellProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(null);
  const [crumb, setCrumb] = useState<string>();
  const item = resolveNavItem(pathname);
  const page = item?.title ?? "Sessions";
  // The workbench names the tab itself, after what its session shows.
  useDocumentTitle(layout === "page" ? (crumb ?? page) : undefined, layout === "page");

  if (layout === "workbench") {
    return (
      <SidebarProvider key="workbench" defaultOpen={false} className={FILLS}>
        <SidebarGoesAway />
        <AppSidebar collapsible="offcanvas" />
        <SidebarInset className={cn(INSET, "aperture:pt-[env(safe-area-inset-top)]")}>
          <WindowTitlebar />
          {children}
        </SidebarInset>
      </SidebarProvider>
    );
  }

  return (
    <SidebarProvider key="page" className={FILLS}>
      <AppSidebar collapsible="icon" />
      <SidebarInset className={INSET}>
        <header
          data-app-titlebar=""
          className="aperture:flex aperture:h-[calc(3rem+env(safe-area-inset-top))] aperture:shrink-0 aperture:items-center aperture:gap-2 aperture:border-b aperture:px-3 aperture:pt-[env(safe-area-inset-top)] aperture:max-sm:gap-1 aperture:max-sm:px-2"
        >
          <SidebarTrigger className="aperture:-ml-1" />
          {crumb === undefined || item === undefined ? (
            <h1 className={TITLE}>{page}</h1>
          ) : (
            <Breadcrumb className={TITLE}>
              <h1 className="aperture:sr-only">{crumb}</h1>
              <BreadcrumbList className="aperture:flex-nowrap aperture:gap-1.5">
                {/* A phone's bar has room for whose page it is, and the menu leads back. */}
                <BreadcrumbItem className="aperture:max-sm:hidden">
                  <BreadcrumbLink
                    data-console-crumb-back
                    className="aperture:font-normal"
                    render={<Link to={item.to} />}
                  >
                    {page}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="aperture:max-sm:hidden" />
                <BreadcrumbItem className="aperture:min-w-0">
                  <BreadcrumbPage
                    data-console-crumb
                    className="aperture:truncate aperture:font-semibold"
                  >
                    {crumb}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          )}
          <div
            ref={setHeaderActions}
            className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:justify-end aperture:gap-2 aperture:max-sm:min-w-min aperture:max-sm:gap-1"
          />
        </header>
        <div className="aperture:relative aperture:min-h-0 aperture:flex-1">
          <PageCrumb.Provider value={setCrumb}>
            <PageHeaderActionsTarget.Provider value={headerActions}>
              {children}
            </PageHeaderActionsTarget.Provider>
          </PageCrumb.Provider>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
