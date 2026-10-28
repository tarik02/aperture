import { createFileRoute } from "@tanstack/react-router";
import { SidebarTrigger } from "@aperture-browser/ui/components/sidebar";
import { SessionWorkbench } from "#/features/workbench/session-workbench.tsx";
import { searchFlag } from "#/lib/search-flag.ts";

export type SessionWorkbenchSearch = {
  /** Skip WebRTC and stream frames over the session socket. */
  media?: "cdp";
  /** Open a new browser tab once connected. */
  newTab?: boolean;
  /** Leave out the app sidebar and links to other pages, for embedding the workbench. */
  embed?: boolean;
};

export const Route = createFileRoute("/-/sessions/$sessionId")({
  validateSearch: (search: Record<string, unknown>): SessionWorkbenchSearch => ({
    media: search["media"] === "cdp" ? "cdp" : undefined,
    newTab: searchFlag(search["newTab"]),
    embed: searchFlag(search["embed"]),
  }),
  component: SessionWorkbenchRoute,
});

function SessionWorkbenchRoute() {
  const { sessionId } = Route.useParams();
  const search = Route.useSearch();
  const embedded = search.embed === true;
  return (
    <SessionWorkbench
      sessionId={sessionId}
      media={search.media}
      openNewTab={search.newTab === true}
      navigation={!embedded}
      leading={
        embedded ? undefined : (
          <SidebarTrigger className="aperture:h-full aperture:w-auto aperture:aspect-square aperture:shrink-0 aperture:rounded-none" />
        )
      }
    />
  );
}
