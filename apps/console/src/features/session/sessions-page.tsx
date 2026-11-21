import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SessionCard } from "#/features/session/session-card.tsx";
import { useCreateSessionMutation } from "#/features/session/session.mutations.ts";
import { useSessionsQuery } from "#/features/session/session.queries.ts";
import { told } from "#/lib/api.ts";

/** An account's sessions, wherever they run. */
export function SessionsPage() {
  const sessions = useSessionsQuery();
  const create = useCreateSessionMutation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const sought = search.trim().toLowerCase();
  const shown = (sessions.data ?? [])
    .filter((session) => sought === "" || session.id.includes(sought))
    .toSorted((one, other) => other.createdAt.epochMilliseconds - one.createdAt.epochMilliseconds);

  const createAndOpen = () =>
    create.mutate(
      {},
      {
        onSuccess: (session) =>
          navigate({ to: "/-/sessions/$sessionId", params: { sessionId: session.id } }),
      },
    );

  return (
    <div className="aperture:flex aperture:flex-col aperture:gap-4 aperture:p-4">
      <PageHeaderActions>
        <Input
          type="search"
          placeholder="Search sessions"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="aperture:h-8 aperture:max-w-56"
        />
        <Button data-console-create size="sm" disabled={create.isPending} onClick={createAndOpen}>
          <Plus />
          New session
        </Button>
      </PageHeaderActions>
      {sessions.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(sessions.error)}
        </p>
      ) : null}
      {sessions.data !== undefined && shown.length === 0 ? (
        <p
          data-console-empty
          className="aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
        >
          {sought === "" ? "No sessions yet." : "No session matches."}
        </p>
      ) : (
        <div className="aperture:grid aperture:grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] aperture:gap-4">
          {shown.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}
