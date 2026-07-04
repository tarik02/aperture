import { createFileRoute } from "@tanstack/react-router";
import { AppWindow } from "lucide-react";
import { PagePlaceholder } from "#/components/page-placeholder.tsx";

export const Route = createFileRoute("/sessions/")({
  component: SessionsPage,
});

function SessionsPage() {
  return <PagePlaceholder title="Sessions" icon={AppWindow} />;
}
