import { createFileRoute } from "@tanstack/react-router";
import { SessionListPage } from "#/features/session/list-page/session-list-page.tsx";

export const Route = createFileRoute("/-/sessions/")({
  component: SessionListPage,
});
