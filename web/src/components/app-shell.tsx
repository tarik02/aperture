import { Separator } from "#/components/ui/separator.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "#/components/ui/sidebar.tsx";
import { AppSidebar } from "#/components/app-sidebar.tsx";
import { AppStatusBar } from "#/components/app-status-bar.tsx";

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  return (
    <SidebarProvider defaultOpen>
      <AppSidebar />
      <SidebarInset className="min-h-svh">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
          <AppStatusBar />
        </header>
        <div className="flex min-h-0 flex-1 flex-col p-3">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
