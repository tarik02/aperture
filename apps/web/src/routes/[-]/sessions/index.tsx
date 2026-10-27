import { createFileRoute } from "@tanstack/react-router";
import { LauncherPage } from "#/features/launcher/launcher-page.tsx";

type SessionsSearch = {
  view?: "snapshots";
};

export const Route = createFileRoute("/-/sessions/")({
  validateSearch: (search: Record<string, unknown>): SessionsSearch =>
    search["view"] === "snapshots" ? { view: "snapshots" } : {},
  component: SessionsRoute,
});

function SessionsRoute() {
  const { view } = Route.useSearch();
  return <LauncherPage view={view ?? "sessions"} />;
}
