import { useEffect, useMemo } from "react";
import { useSessionsInfiniteQuery } from "#/features/session/session.queries.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import type { Session } from "#/lib/api/schemas.ts";

type UseWorkbenchSessionResult = {
  session: Session | null;
  runningSessions: Session[];
  isResolvingRoute: boolean;
};

export function useWorkbenchSession(sessionId: string | undefined): UseWorkbenchSessionResult {
  const runningSessionsQuery = useSessionsInfiniteQuery({ status: "running", limit: 50 });
  const runningSessions = useMemo(
    () => flattenInfinitePages(runningSessionsQuery.data?.pages),
    [runningSessionsQuery.data],
  );

  const session = useMemo(
    () => (sessionId ? (runningSessions.find((item) => item.id === sessionId) ?? null) : null),
    [runningSessions, sessionId],
  );

  const isResolvingRoute = Boolean(
    sessionId &&
    !session &&
    (runningSessionsQuery.isLoading ||
      runningSessionsQuery.isFetchingNextPage ||
      runningSessionsQuery.hasNextPage),
  );

  useEffect(() => {
    if (!sessionId || session) {
      return;
    }
    if (runningSessionsQuery.isLoading || runningSessionsQuery.isFetchingNextPage) {
      return;
    }
    if (!runningSessionsQuery.hasNextPage) {
      return;
    }
    void runningSessionsQuery.fetchNextPage();
  }, [
    sessionId,
    session,
    runningSessionsQuery.isLoading,
    runningSessionsQuery.isFetchingNextPage,
    runningSessionsQuery.hasNextPage,
    runningSessionsQuery.fetchNextPage,
  ]);

  return {
    session,
    runningSessions,
    isResolvingRoute,
  };
}
