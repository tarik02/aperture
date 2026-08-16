import { useRouterState } from "@tanstack/react-router";
import { Separator } from "#/components/ui/separator.tsx";
import { SidebarInset, SidebarTrigger } from "#/components/ui/sidebar.tsx";
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
      <SidebarInset className="h-full min-h-0 overflow-hidden">
        <header data-app-titlebar className="flex shrink-0 items-center gap-2 border-b">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
          <h1 className="min-w-0 truncate text-sm font-semibold">{pageTitle}</h1>
          <div
            id="app-header-actions"
            data-no-window-drag
            className="ml-auto flex items-center gap-2"
          />
        </header>
        <div className="min-h-0 flex-1">{children}</div>
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
