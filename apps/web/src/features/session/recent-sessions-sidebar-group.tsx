import { useNavigate } from "@tanstack/react-router";
import { AppWindow } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@aperture-browser/ui/components/sidebar";
import { useRecentSessionsStore } from "#/features/session/recent-sessions.store.ts";
import { useSessionsBulkQuery } from "#/features/session/session.queries.ts";
import type { Session, SessionStatus } from "@aperture-browser/api-client";
import { cn } from "@aperture-browser/ui/utils";
import { SessionThumbnail } from "#/features/launcher/session-thumbnail.tsx";
import {
  isExpired,
  sessionLabel,
  sessionThumbnailUrl,
  versionedUrl,
} from "#/features/session/session-display.ts";
import {
  sessionHref,
  sessionLinkHandlers,
  useOpenSessions,
} from "#/features/session/open-sessions.ts";

type RecentSessionsSidebarGroupProps = {
  pathname: string;
};

export function RecentSessionsSidebarGroup({ pathname }: RecentSessionsSidebarGroupProps) {
  const navigate = useNavigate();
  const openSessions = useOpenSessions();
  const sessionIds = useRecentSessionsStore((state) => state.sessionIds);
  const sessionsQuery = useSessionsBulkQuery(sessionIds);
  const sessions = sessionsQuery.data ?? [];

  // Sessions that can no longer be opened only clutter the list.
  const visible = sessions.filter((session) => !isExpired(session) && session.status !== "deleted");
  if (visible.length === 0) {
    return null;
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Recent sessions</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {visible.map((session) => {
            const title = sessionLabel(session);
            const href = sessionHref(session.id);
            const current = pathname === `/-/sessions/${session.id}`;
            const openElsewhere = !current && (openSessions.get(session.id)?.tabs ?? 0) > 0;
            return (
              <SidebarMenuItem key={session.id}>
                <SidebarMenuButton
                  isActive={current}
                  className="aperture:h-auto aperture:gap-2.5 aperture:p-1.5 aperture:group-data-[collapsible=icon]:h-8 aperture:group-data-[collapsible=icon]:p-2!"
                  render={
                    <a
                      href={href}
                      {...sessionLinkHandlers({
                        sessionId: session.id,
                        href,
                        isOpenElsewhere: openElsewhere,
                        onNavigate: () =>
                          void navigate({
                            to: "/-/sessions/$sessionId",
                            params: { sessionId: session.id },
                          }),
                      })}
                    />
                  }
                  tooltip={`${title} · ${session.status}`}
                >
                  <SessionPreview session={session} version={sessionsQuery.dataUpdatedAt} />
                  <span data-sidebar-collapse-label className="aperture:grid aperture:min-w-0">
                    <span className="aperture:truncate">{title}</span>
                    <span className="aperture:truncate aperture:text-xs aperture:font-normal aperture:text-sidebar-foreground/60">
                      {openElsewhere ? `${session.status} · open in a tab` : session.status}
                    </span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** The page preview with a status dot; an icon rail has only room for the icon and the dot. */
function SessionPreview({ session, version }: { session: Session; version: number }) {
  const thumbnail = sessionThumbnailUrl(session);
  const dot = (
    <span
      aria-hidden
      className={cn(
        "aperture:absolute aperture:-right-0.5 aperture:-bottom-0.5 aperture:size-2 aperture:rounded-full aperture:ring-2 aperture:ring-sidebar",
        statusDot[session.status] ?? "aperture:bg-muted-foreground/50",
      )}
    />
  );
  return (
    <>
      <span className="aperture:relative aperture:aspect-video aperture:w-14 aperture:shrink-0 aperture:group-data-[collapsible=icon]:hidden">
        <span className="aperture:absolute aperture:inset-0 aperture:overflow-hidden aperture:rounded aperture:ring-1 aperture:ring-sidebar-foreground/10">
          <SessionThumbnail
            src={thumbnail ? versionedUrl(thumbnail, version) : null}
            // The sidebar is a hover group too; the preview stays still inside it.
            className="aperture:group-hover:scale-100"
          />
        </span>
        {dot}
      </span>
      <span className="aperture:relative aperture:hidden aperture:group-data-[collapsible=icon]:block">
        <AppWindow />
        {dot}
      </span>
    </>
  );
}

const statusDot: Partial<Record<SessionStatus, string>> = {
  running: "aperture:bg-emerald-500",
  creating: "aperture:bg-amber-500",
  suspended: "aperture:bg-muted-foreground/50",
  failed: "aperture:bg-destructive",
};
