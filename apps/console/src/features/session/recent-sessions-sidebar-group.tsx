import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@aperture-browser/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import { useRecentSessions } from "#/features/session/recent-sessions.ts";
import { useOpenSession } from "#/features/session/use-open-session.ts";
import { SessionPicture, useSessionPicture } from "#/features/session/session-picture.tsx";
import { type Session, useSessionsQuery } from "#/features/session/session.queries.ts";

/** Wide enough for a screen that packs two pixels into one. */
const THUMBNAIL_WIDTH = 120;

/** A session among the last opened: a glimpse of the page it shows, and what it is called. */
function RecentSession({ session, active }: { session: Session; active: boolean }) {
  const { source, target } = useSessionPicture(session, THUMBNAIL_WIDTH);
  const open = useOpenSession(session.id, source);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        data-console-recent={session.id}
        render={
          <Link
            to="/-/sessions/$sessionId"
            params={{ sessionId: session.id }}
            onClick={open.onClick}
          />
        }
      >
        <span
          style={open.moving}
          className="aperture:flex aperture:h-6 aperture:w-10 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:overflow-hidden aperture:rounded-sm aperture:border aperture:bg-muted aperture:text-muted-foreground"
        >
          <SessionPicture
            source={source}
            markClassName="aperture:size-3.5!"
            className={open.opening ? "aperture:blur-xs" : undefined}
          />
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
