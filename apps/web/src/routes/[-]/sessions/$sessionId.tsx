import { createFileRoute } from "@tanstack/react-router";
import { SessionDetailPage } from "#/features/session/detail-page/session-detail-page.tsx";

export const Route = createFileRoute("/-/sessions/$sessionId")({
  component: SessionDetailRoute,
});

function SessionDetailRoute() {
  const { sessionId } = Route.useParams();
  return <SessionDetailPage sessionId={sessionId} />;
}
