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
import type { SessionStatus } from "@aperture-browser/api-client";
import { cn } from "@aperture-browser/ui/utils";
import { isExpired, sessionLabel } from "#/features/session/session-display.ts";
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
            return (
              <SidebarMenuItem key={session.id}>
                <SidebarMenuButton
                  isActive={current}
                  render={
                    <a
                      href={href}
                      {...sessionLinkHandlers({
                        sessionId: session.id,
                        href,
                        isOpenElsewhere: !current && (openSessions.get(session.id)?.tabs ?? 0) > 0,
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
                  <span className="aperture:relative">
                    <AppWindow />
                    <span
                      aria-hidden
                      className={cn(
                        "aperture:absolute aperture:-right-0.5 aperture:-bottom-0.5 aperture:size-2 aperture:rounded-full aperture:ring-2 aperture:ring-sidebar",
                        statusDot[session.status] ?? "aperture:bg-muted-foreground/50",
                      )}
                    />
                  </span>
                  <span data-sidebar-collapse-label className="aperture:truncate">
                    {title}
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

const statusDot: Partial<Record<SessionStatus, string>> = {
  running: "aperture:bg-emerald-500",
  creating: "aperture:bg-amber-500",
  suspended: "aperture:bg-muted-foreground/50",
  failed: "aperture:bg-destructive",
};
