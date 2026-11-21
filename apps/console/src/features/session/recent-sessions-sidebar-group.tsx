import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@aperture-browser/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import { History } from "lucide-react";
import { useRecentSessions } from "#/features/session/recent-sessions.ts";
import { useSessionsQuery } from "#/features/session/session.queries.ts";

/** The sessions last opened in this browser, those that are still there. */
export function RecentSessionsSidebarGroup({ pathname }: { pathname: string }) {
  const recent = useRecentSessions();
  const sessions = useSessionsQuery();
  const known = recent.flatMap((id) => sessions.data?.find((session) => session.id === id) ?? []);

  if (known.length === 0) {
    return null;
  }
  return (
    <SidebarGroup className="aperture:group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Recent</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {known.map((session) => (
            <SidebarMenuItem key={session.id}>
              <SidebarMenuButton
                isActive={pathname === `/-/sessions/${session.id}`}
                render={<Link to="/-/sessions/$sessionId" params={{ sessionId: session.id }} />}
              >
                <History />
                <span className="aperture:truncate">{session.label ?? session.id}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
