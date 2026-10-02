import { useRouterState } from "@tanstack/react-router";
import { Separator } from "@aperture-browser/ui/components/separator";
import { SidebarInset, SidebarTrigger } from "@aperture-browser/ui/components/sidebar";
import { AppSidebar } from "#/components/app-sidebar.tsx";
import { primaryNavItems } from "#/lib/navigation.ts";

type StandardAppShellProps = {
  children: React.ReactNode;
};

export default function StandardAppShell({ children }: StandardAppShellProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pageTitle = resolvePageTitle(pathname);

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
        <div className="aperture:min-h-0 aperture:flex-1">{children}</div>
      </SidebarInset>
    </>
  );
}

function resolvePageTitle(pathname: string) {
  const item = primaryNavItems.find((navItem) => {
    if (navItem.to === "/") {
      return pathname === "/";
    }
    return pathname === navItem.to || pathname.startsWith(`${navItem.to}/`);
  });
  return item?.title ?? "Sessions";
}
