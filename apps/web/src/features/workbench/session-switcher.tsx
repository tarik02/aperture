import { Link, useNavigate } from "@tanstack/react-router";
import { LayoutGrid, Plus, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { EdgePanel } from "#/features/workbench/edge-panel.tsx";
import { flattenInfinitePages, type Session } from "@aperture-browser/api-client";
import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { cn } from "@aperture-browser/ui/utils";
import { SessionThumbnail } from "#/features/launcher/session-thumbnail.tsx";
import {
  sessionHref,
  sessionLinkHandlers,
  useOpenSessions,
} from "#/features/session/open-sessions.ts";
import {
  isExpired,
  matchesSearch,
  sessionLabel,
  sessionThumbnailUrl,
  versionedUrl,
} from "#/features/session/session-display.ts";
import { useSessionsInfiniteQuery } from "#/features/session/session.queries.ts";

type SessionSwitcherProps = {
  currentSessionId: string;
  /** Docked beside the browser; the workbench title bar toggles it. */
  pinned: boolean;
  onNewSession?: () => void;
};

/** The session list along the left edge of the workbench. */
export function SessionSwitcher({ currentSessionId, pinned, onNewSession }: SessionSwitcherProps) {
  return (
    <EdgePanel side="left" pinned={pinned}>
      {(close) => (
        <SessionSwitcherPanel
          currentSessionId={currentSessionId}
          onNewSession={onNewSession}
          onNavigate={close}
        />
      )}
    </EdgePanel>
  );
}

function SessionSwitcherPanel({
  currentSessionId,
  onNewSession,
  onNavigate,
}: {
  currentSessionId: string;
  onNewSession?: () => void;
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const query = useSessionsInfiniteQuery({ limit: 100 }, { poll: true });
  const openSessions = useOpenSessions();
  const sessions = useMemo(() => {
    const now = Date.now();
    return flattenInfinitePages(query.data?.pages)
      .filter(
        (session) =>
          !isExpired(session, now) && session.status !== "deleted" && session.status !== "failed",
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [query.data?.pages]);
  const needle = search.trim().toLowerCase();
  const visible = needle
    ? sessions.filter((session) =>
        matchesSearch(needle, [session.label, session.baseSnapshotName, session.id]),
      )
    : sessions;

  return (
    <>
      <div className="aperture:flex aperture:h-9 aperture:shrink-0 aperture:items-center aperture:gap-1 aperture:border-b aperture:px-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="aperture:min-w-0 aperture:flex-1 aperture:justify-start"
          render={<Link to="/-/sessions" />}
          nativeButton={false}
        >
          <LayoutGrid data-icon="inline-start" />
          All sessions
        </Button>
        {onNewSession ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New session"
            title="New session"
            onClick={onNewSession}
          >
            <Plus />
          </Button>
        ) : null}
      </div>
      <div className="aperture:relative aperture:shrink-0 aperture:p-2">
        <SearchIcon className="aperture:pointer-events-none aperture:absolute aperture:top-1/2 aperture:left-4.5 aperture:size-4 aperture:-translate-y-1/2 aperture:text-muted-foreground" />
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Switch session"
          aria-label="Switch session"
          className="aperture:h-8 aperture:pl-8"
        />
      </div>
      <ScrollArea className="aperture:min-h-0 aperture:flex-1">
        <nav className="aperture:grid aperture:gap-0.5 aperture:px-2 aperture:pb-2">
          {visible.map((session) => (
            <SwitcherRow
              key={session.id}
              session={session}
              current={session.id === currentSessionId}
              openElsewhere={(openSessions.get(session.id)?.tabs ?? 0) > 0}
              version={query.dataUpdatedAt}
              onNavigate={() => {
                onNavigate();
                void navigate({
                  to: "/-/sessions/$sessionId",
                  params: { sessionId: session.id },
                });
              }}
            />
          ))}
          {visible.length === 0 && !query.isPending ? (
            <p className="aperture:px-2 aperture:py-6 aperture:text-center aperture:text-sm aperture:text-muted-foreground">
              {needle ? "No sessions match." : "No other sessions."}
            </p>
          ) : null}
        </nav>
      </ScrollArea>
    </>
  );
}

function SwitcherRow({
  session,
  current,
  openElsewhere,
  version,
  onNavigate,
}: {
  session: Session;
  current: boolean;
  openElsewhere: boolean;
  version: number;
  onNavigate: () => void;
}) {
  const href = sessionHref(session.id);
  const thumbnail = sessionThumbnailUrl(session);
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "aperture:group aperture:flex aperture:items-center aperture:gap-2.5 aperture:rounded-lg aperture:p-1.5 aperture:text-left aperture:outline-none aperture:hover:bg-sidebar-accent aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50",
        current && "aperture:bg-sidebar-accent",
      )}
      {...sessionLinkHandlers({
        sessionId: session.id,
        href,
        isOpenElsewhere: openElsewhere && !current,
        onNavigate: current ? () => {} : onNavigate,
      })}
    >
      <span
        className={cn(
          "aperture:relative aperture:aspect-video aperture:w-16 aperture:shrink-0 aperture:overflow-hidden aperture:rounded-md aperture:ring-1 aperture:ring-foreground/10",
          current && "aperture:ring-2 aperture:ring-primary",
        )}
      >
        <SessionThumbnail src={thumbnail ? versionedUrl(thumbnail, version) : null} />
      </span>
      <span className="aperture:grid aperture:min-w-0 aperture:flex-1">
        <span className="aperture:truncate aperture:text-sm aperture:font-medium">
          {sessionLabel(session)}
        </span>
        <span className="aperture:flex aperture:items-center aperture:gap-1.5 aperture:text-xs aperture:text-muted-foreground">
          <Badge
            variant={session.status === "running" ? "default" : "outline"}
            className="aperture:h-4 aperture:px-1.5 aperture:text-[0.65rem]"
          >
            {session.status}
          </Badge>
          {openElsewhere && !current ? (
            <span className="aperture:truncate">open in a tab</span>
          ) : null}
        </span>
      </span>
    </a>
  );
}
