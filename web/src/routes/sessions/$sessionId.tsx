import { createFileRoute } from "@tanstack/react-router";
import { AppWindow } from "lucide-react";
import { PagePlaceholder } from "#/components/page-placeholder.tsx";

export const Route = createFileRoute("/sessions/$sessionId")({
  component: SessionDetailPage,
});

function SessionDetailPage() {
  const { sessionId } = Route.useParams();

  return <PagePlaceholder title={sessionId} icon={AppWindow} />;
}
