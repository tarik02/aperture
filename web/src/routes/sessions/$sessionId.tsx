import { createFileRoute } from "@tanstack/react-router";
import { SessionDetailPage } from "#/features/session/detail-page/session-detail-page.tsx";

type SessionSearch = {
  media?: "cdp";
};

export const Route = createFileRoute("/sessions/$sessionId")({
  validateSearch: (search: Record<string, unknown>): SessionSearch => ({
    media: search.media === "cdp" ? "cdp" : undefined,
  }),
  component: SessionDetailRoute,
});

function SessionDetailRoute() {
  const { sessionId } = Route.useParams();
  const search = Route.useSearch();
  return <SessionDetailPage sessionId={sessionId} forceCDPMedia={search.media === "cdp"} />;
}
