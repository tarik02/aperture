import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SessionStatusBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Input } from "@aperture-browser/ui/components/input";
import { useSessionsInfiniteQuery } from "#/features/session/session.queries.ts";
import type { Session } from "@aperture-browser/api-client";
import { cn } from "@aperture-browser/ui/utils";

type SessionListPaneProps = {
  selectedSessionId: string | null;
  search: string;
  onSearchChange: (value: string) => void;
};

export function SessionListPane({
  selectedSessionId,
  search,
  onSearchChange,
}: SessionListPaneProps) {
  const navigate = useNavigate();
  const query = useSessionsInfiniteQuery({ limit: 100 });
  const sessions = useMemo(
    () =>
      query.data?.pages
        .flatMap((page) => page.data)
        .filter(
          (session) =>
            session.status === "creating" ||
            session.status === "running" ||
            session.status === "suspended",
        ) ?? [],
    [query.data],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return sessions;
    }
    return sessions.filter((session) => {
      return (
        session.id.toLowerCase().includes(needle) ||
        session.label?.toLowerCase().includes(needle) ||
        session.baseSnapshotName?.toLowerCase().includes(needle) ||
        Object.entries(session.tags ?? {}).some(
          ([key, value]) =>
            key.toLowerCase().includes(needle) || value.toLowerCase().includes(needle),
        )
      );
    });
  }, [sessions, search]);

  function selectSession(session: Session) {
    void navigate({ to: "/-/sessions/$sessionId", params: { sessionId: session.id } });
  }

  return (
    <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-col aperture:border-r">
      <div className="aperture:border-b aperture:p-2">
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Filter sessions"
          className="aperture:h-7 aperture:text-xs"
        />
      </div>
      <ScrollArea className="aperture:min-h-0 aperture:flex-1">
        <div className="aperture:space-y-1 aperture:p-1">
          {filtered.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => selectSession(session)}
              className={cn(
                "aperture:w-full aperture:rounded-md aperture:border aperture:px-2 aperture:py-1.5 aperture:text-left aperture:transition-colors",
                selectedSessionId === session.id
                  ? "aperture:border-primary/40 aperture:bg-primary/10"
                  : "aperture:border-transparent aperture:hover:bg-muted/60",
              )}
            >
              <div className="aperture:space-y-1">
                {session.label ? (
                  <span className="aperture:block aperture:truncate aperture:text-sm aperture:font-medium aperture:leading-snug">
                    {session.label}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "aperture:block aperture:break-all aperture:font-mono aperture:leading-snug",
                    session.label
                      ? "aperture:text-xs aperture:text-muted-foreground"
                      : "aperture:text-sm",
                  )}
                >
                  {session.id}
                </span>
                <SessionStatusBadge status={session.status} />
              </div>
              <div className="aperture:mt-1 aperture:text-sm aperture:text-muted-foreground">
                {session.baseSnapshotName ?? "—"}
              </div>
              <TagBadges tags={session.tags} max={2} />
            </button>
          ))}
          {filtered.length === 0 ? (
            <div className="aperture:px-2 aperture:py-6 aperture:text-center aperture:text-xs aperture:text-muted-foreground">
              No controllable sessions
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
