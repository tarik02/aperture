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
} from "@aperture-browser/ui/components/sidebar";
import { useRecentSessionsStore } from "#/features/session/recent-sessions.store.ts";
import { useSessionsBulkQuery } from "#/features/session/session.queries.ts";
import type { Session } from "@aperture-browser/api-client";

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
      <SidebarGroup className="aperture:p-1.5">
        <SidebarGroupLabel>Recent sessions</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu className="aperture:gap-1">
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
                    <span
                      data-sidebar-collapse-label
                      className="aperture:flex aperture:min-w-0 aperture:flex-col"
                    >
                      <span className="aperture:truncate">{title}</span>
                      <span className="aperture:truncate aperture:text-xs aperture:font-normal aperture:text-sidebar-foreground/60">
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
