import { createFileRoute } from "@tanstack/react-router";
import { SnapshotListPage } from "#/features/snapshot/list-page/snapshot-list-page.tsx";

export const Route = createFileRoute("/-/snapshots/")({
  component: SnapshotListPage,
});
