import { createFileRoute } from "@tanstack/react-router";
import { SessionWorkbench } from "#/features/workbench/session-workbench.tsx";

export type SessionWorkbenchSearch = {
  /** Skip WebRTC and stream frames over the session socket. */
  media?: "cdp";
  /** Open a new browser tab once connected. */
  newTab?: boolean;
  /** Hide navigation to other sessions, for embedding the workbench in another page. */
  embed?: boolean;
};

// Search values arrive parsed as JSON, so `?embed=1` is the number 1.
const flag = (value: unknown) =>
  value === true || value === 1 || value === "1" || value === "true" ? true : undefined;

export const Route = createFileRoute("/-/sessions/$sessionId")({
  validateSearch: (search: Record<string, unknown>): SessionWorkbenchSearch => ({
    media: search["media"] === "cdp" ? "cdp" : undefined,
    newTab: flag(search["newTab"]),
    embed: flag(search["embed"]),
  }),
  component: SessionWorkbenchRoute,
});

function SessionWorkbenchRoute() {
  const { sessionId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <SessionWorkbench
      key={sessionId}
      sessionId={sessionId}
      media={search.media}
      openNewTab={search.newTab === true}
      navigation={search.embed !== true}
    />
  );
}
