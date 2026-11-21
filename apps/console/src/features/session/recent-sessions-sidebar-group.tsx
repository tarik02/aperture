import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@aperture-browser/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import { AppWindow } from "lucide-react";
import { useRecentSessions } from "#/features/session/recent-sessions.ts";
import {
  type Session,
  useSessionsQuery,
  useSessionTargetsQuery,
} from "#/features/session/session.queries.ts";

/** Wide enough for a screen that packs two pixels into one. */
const THUMBNAIL_WIDTH = 120;

/** A session among the last opened: a glimpse of the page it shows, and what it is called. */
function RecentSession({ session, active }: { session: Session; active: boolean }) {
  const shown = useSessionTargetsQuery(session);
  const target = shown.data?.targets[0];

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        data-console-recent={session.id}
        render={<Link to="/-/sessions/$sessionId" params={{ sessionId: session.id }} />}
      >
        <span className="aperture:flex aperture:h-6 aperture:w-10 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:overflow-hidden aperture:rounded-sm aperture:border aperture:bg-muted aperture:text-muted-foreground">
          {target !== undefined && session.path !== null ? (
            <img
              alt=""
              // What the page shows changes while its address does not.
              src={`${session.path}/targets/${target.tab}/screenshot.png?width=${THUMBNAIL_WIDTH}&at=${shown.data?.at}`}
              className="aperture:size-full aperture:object-cover aperture:object-top"
            />
          ) : (
            <AppWindow className="aperture:size-3.5!" />
          )}
        </span>
        <span className="aperture:truncate">{session.label ?? (target?.title || session.id)}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

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
            <RecentSession
              key={session.id}
              session={session}
              active={pathname === `/-/sessions/${session.id}`}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
