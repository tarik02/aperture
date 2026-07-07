import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SessionStatusBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useSessionsInfiniteQuery } from "#/features/session/session.queries.ts";
import type { Session } from "#/lib/api/schemas.ts";
import { cn } from "#/lib/utils.ts";

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
  const query = useSessionsInfiniteQuery({ status: "running", limit: 100 });
  const sessions = useMemo(
    () => query.data?.pages.flatMap((page) => page.data) ?? [],
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
    void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } });
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-r">
      <div className="border-b p-2">
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Filter sessions"
          className="h-7 text-xs"
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-1">
          {filtered.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => selectSession(session)}
              className={cn(
                "w-full rounded-md border px-2 py-1.5 text-left transition-colors",
                selectedSessionId === session.id
                  ? "border-primary/40 bg-primary/10"
                  : "border-transparent hover:bg-muted/60",
              )}
            >
              <div className="space-y-1">
                {session.label ? (
                  <span className="block truncate text-sm font-medium leading-snug">
                    {session.label}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "block break-all font-mono leading-snug",
                    session.label ? "text-xs text-muted-foreground" : "text-sm",
                  )}
                >
                  {session.id}
                </span>
                <SessionStatusBadge status={session.status} />
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {session.baseSnapshotName ?? "—"}
              </div>
              <TagBadges tags={session.tags} max={2} />
            </button>
          ))}
          {filtered.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              No running sessions
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
