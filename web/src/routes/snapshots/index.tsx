import { createFileRoute } from "@tanstack/react-router";
import { Camera } from "lucide-react";
import { PagePlaceholder } from "#/components/page-placeholder.tsx";

export const Route = createFileRoute("/snapshots/")({
  component: SnapshotsPage,
});

function SnapshotsPage() {
  return <PagePlaceholder title="Snapshots" icon={Camera} />;
}
