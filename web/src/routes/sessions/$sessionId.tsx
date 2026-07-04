import { createFileRoute } from "@tanstack/react-router";
import { SessionWorkbench } from "#/components/workbench/session-workbench.tsx";

export const Route = createFileRoute("/sessions/$sessionId")({
  component: SessionDetailPage,
});

function SessionDetailPage() {
  const { sessionId } = Route.useParams();
  return <SessionWorkbench sessionId={sessionId} />;
}
