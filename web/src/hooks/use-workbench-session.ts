import { useEffect, useMemo } from "react";
import { useSessionsInfiniteQuery } from "#/features/session/session.queries.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import type { Session } from "#/lib/api/schemas.ts";

type UseWorkbenchSessionResult = {
  session: Session | null;
  isResolvingRoute: boolean;
};

export function useWorkbenchSession(sessionId: string | undefined): UseWorkbenchSessionResult {
  const sessionsQuery = useSessionsInfiniteQuery({ limit: 50 });
  const sessions = useMemo(
    () => flattenInfinitePages(sessionsQuery.data?.pages),
    [sessionsQuery.data],
  );

  const session = useMemo(
    () => (sessionId ? (sessions.find((item) => item.id === sessionId) ?? null) : null),
    [sessions, sessionId],
  );

  const isResolvingRoute = Boolean(
    sessionId &&
    !session &&
    (sessionsQuery.isLoading || sessionsQuery.isFetchingNextPage || sessionsQuery.hasNextPage),
  );

  useEffect(() => {
    if (!sessionId || session) {
      return;
    }
    if (sessionsQuery.isLoading || sessionsQuery.isFetchingNextPage) {
      return;
    }
    if (!sessionsQuery.hasNextPage) {
      return;
    }
    void sessionsQuery.fetchNextPage();
  }, [
    sessionId,
    session,
    sessionsQuery.isLoading,
    sessionsQuery.isFetchingNextPage,
    sessionsQuery.hasNextPage,
    sessionsQuery.fetchNextPage,
  ]);

  return {
    session,
    isResolvingRoute,
  };
}
