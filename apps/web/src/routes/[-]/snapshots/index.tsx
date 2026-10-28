import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/-/snapshots/")({
  component: SnapshotsRoute,
});

function SnapshotsRoute() {
  return <Navigate to="/-/sessions" search={{ view: "snapshots" }} replace />;
}
