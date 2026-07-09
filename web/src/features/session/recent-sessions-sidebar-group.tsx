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
import { useRecentSessionsStore } from "#/features/session/recent-sessions.store.ts";
import { useSessionsBulkQuery } from "#/features/session/session.queries.ts";
import type { Session } from "#/lib/api/schemas.ts";

type RecentSessionsSidebarGroupProps = {
  pathname: string;
};

export function RecentSessionsSidebarGroup({ pathname }: RecentSessionsSidebarGroupProps) {
  const sessionIds = useRecentSessionsStore((state) => state.sessionIds);
  const sessionsQuery = useSessionsBulkQuery(sessionIds);
  const sessions = sessionsQuery.data ?? [];

  if (sessionIds.length === 0 || sessions.length === 0) {
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
                    isActive={pathname === `/-/sessions/${session.id}`}
                    render={<Link to="/-/sessions/$sessionId" params={{ sessionId: session.id }} />}
                    tooltip={title}
                  >
                    <AppWindow />
                    <span data-sidebar-collapse-label className="flex min-w-0 flex-col">
                      <span className="truncate">{title}</span>
                      <span className="truncate text-xs font-normal text-sidebar-foreground/60">
                        {session.browserChannel
                          ? `${session.status} · ${session.browserChannel}`
                          : session.status}
                      </span>
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

function recentSessionTitle(session: Session) {
  return session.label ?? session.baseSnapshotName ?? session.id.slice(0, 8);
}
