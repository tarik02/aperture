import { useRouterState } from "@tanstack/react-router";
import { Separator } from "@aperture-browser/ui/components/separator";
import { SidebarInset, SidebarTrigger } from "@aperture-browser/ui/components/sidebar";
import { AppSidebar } from "#/components/app-sidebar.tsx";
import { primaryNavItems } from "#/lib/navigation.ts";
import { NoTenantState } from "#/features/tenant/no-tenant-state.tsx";
import { selectAuth, useAuthSessionStore } from "#/stores/auth-session.ts";

type StandardAppShellProps = {
  children: React.ReactNode;
};

export default function StandardAppShell({ children }: StandardAppShellProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navItem = resolveNavItem(pathname);
  const pageTitle = navItem?.title ?? "Sessions";
  const auth = useAuthSessionStore(selectAuth);
  // Tenant-scoped requests fail until a tenant is selected, so show why instead.
  const missingTenant =
    (navItem?.tenantScoped ?? true) &&
    auth?.principal.type === "user" &&
    auth.principal.authorityType === "tenant" &&
    auth.selectedTenant === null;

  return (
    <>
      <AppSidebar />
      <SidebarInset className="aperture:h-full aperture:min-h-0 aperture:overflow-hidden">
        <header
          data-app-titlebar
          className="aperture:flex aperture:shrink-0 aperture:items-center aperture:gap-2 aperture:border-b"
        >
          <SidebarTrigger className="aperture:-ml-1" />
          <Separator orientation="vertical" className="aperture:h-4" />
          <h1 className="aperture:min-w-0 aperture:truncate aperture:text-sm aperture:font-semibold">
            {pageTitle}
          </h1>
          <div
            id="app-header-actions"
            data-no-window-drag
            className="aperture:ml-auto aperture:flex aperture:items-center aperture:gap-2"
          />
        </header>
        <div className="aperture:min-h-0 aperture:flex-1">
          {missingTenant ? <NoTenantState /> : children}
        </div>
      </SidebarInset>
    </>
  );
}

function resolveNavItem(pathname: string) {
  return primaryNavItems.find((navItem) => {
    if (navItem.to === "/") {
      return pathname === "/";
    }
    return pathname === navItem.to || pathname.startsWith(`${navItem.to}/`);
  });
}
