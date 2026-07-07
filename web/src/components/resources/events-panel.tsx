import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import { formatTimestamp } from "#/lib/format.ts";
import type { ResourceEvent } from "#/lib/api/schemas.ts";
import { useEventsInfiniteQuery } from "#/features/event/event.queries.ts";
import { Button } from "#/components/ui/button.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";

type EventsPanelProps = {
  resourceType: string;
  resourceId: string;
};

export function EventsPanel({ resourceType, resourceId }: EventsPanelProps) {
  const query = useEventsInfiniteQuery({ resourceType, resourceId, limit: 20 });
  const events = flattenInfinitePages(query.data?.pages);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Events</h3>
      {query.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events</p>
      ) : (
        <ScrollArea className="max-h-64">
          <ul className="space-y-2 pr-3">
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
        </ScrollArea>
      )}
      {query.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? "Loading…" : "More"}
        </Button>
      ) : null}
    </div>
  );
}

function EventRow({ event }: { event: ResourceEvent }) {
  return (
    <li className="rounded-md border px-2 py-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{event.type}</span>
        <time className="shrink-0 text-muted-foreground">{formatTimestamp(event.createdAt)}</time>
      </div>
      {event.message ? <p className="mt-0.5 text-muted-foreground">{event.message}</p> : null}
    </li>
  );
}
