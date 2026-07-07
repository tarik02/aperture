import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Separator } from "#/components/ui/separator.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "#/components/ui/sidebar.tsx";
import { AppSidebar } from "#/components/app-sidebar.tsx";
import { primaryNavItems } from "#/lib/navigation.ts";

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const [mounted, setMounted] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isWorkbenchRoute = /^\/sessions\/[^/]+\/?$/.test(pathname);
  const pageTitle = resolvePageTitle(pathname);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="fixed inset-0 bg-background" />;
  }

  if (isWorkbenchRoute) {
    return (
      <SidebarProvider
        data-app-shell
        defaultOpen
        className="fixed inset-0 h-svh min-h-0 overflow-hidden bg-background"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">{children}</div>
      </SidebarProvider>
    );
  }

  return (
    <SidebarProvider data-app-shell defaultOpen className="h-svh min-h-0 overflow-hidden">
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
    </SidebarProvider>
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
