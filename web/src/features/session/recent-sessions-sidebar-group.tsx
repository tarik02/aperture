import { Link } from "@tanstack/react-router";
import { AppWindow } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "#/components/ui/sidebar.tsx";
import {
  useRecentSessionsStore,
  type RecentSession,
} from "#/features/session/recent-sessions.store.ts";

type RecentSessionsSidebarGroupProps = {
  pathname: string;
};

export function RecentSessionsSidebarGroup({ pathname }: RecentSessionsSidebarGroupProps) {
  const sessions = useRecentSessionsStore((state) => state.sessions);

  if (sessions.length === 0) {
    return null;
  }

  return (
    <>
      <SidebarSeparator />
      <SidebarGroup className="p-1.5">
        <SidebarGroupLabel>Recent sessions</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu className="gap-1">
            {sessions.map((session) => {
              const title = recentSessionTitle(session);

              return (
                <SidebarMenuItem key={session.id}>
                  <SidebarMenuButton
                    size="lg"
                    isActive={pathname === `/sessions/${session.id}`}
                    render={<Link to="/sessions/$sessionId" params={{ sessionId: session.id }} />}
                    tooltip={title}
                  >
                    <AppWindow />
                    <span data-sidebar-collapse-label className="flex min-w-0 flex-col">
                      <span className="truncate">{title}</span>
                      {session.browserChannel ? (
                        <span className="truncate text-xs font-normal text-sidebar-foreground/60">
                          {session.browserChannel}
                        </span>
                      ) : null}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

function recentSessionTitle(session: RecentSession) {
  return session.label ?? session.baseSnapshotName ?? session.id.slice(0, 8);
}
