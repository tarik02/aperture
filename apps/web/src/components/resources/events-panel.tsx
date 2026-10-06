import { flattenInfinitePages } from "@aperture-browser/api-client";
import { formatTimestamp } from "#/lib/format.ts";
import type { ResourceEvent } from "@aperture-browser/api-client";
import { useEventsInfiniteQuery } from "#/features/event/event.queries.ts";
import { Button } from "@aperture-browser/ui/components/button";
import { Empty, EmptyHeader, EmptyTitle } from "@aperture-browser/ui/components/empty";
import { Skeleton } from "@aperture-browser/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import { cn } from "@aperture-browser/ui/utils";

type EventsPanelProps = {
  resourceType: string;
  resourceId: string;
  className?: string;
};

export function EventsPanel({ resourceType, resourceId, className }: EventsPanelProps) {
  const query = useEventsInfiniteQuery({ resourceType, resourceId, limit: 20 });
  const events = flattenInfinitePages(query.data?.pages);

  return (
    <div
      className={cn("aperture:flex aperture:min-h-0 aperture:flex-col aperture:gap-3", className)}
    >
      {query.isLoading ? (
        <div className="aperture:flex aperture:flex-col aperture:gap-2">
          <Skeleton className="aperture:h-8 aperture:w-full" />
          <Skeleton className="aperture:h-10 aperture:w-full" />
          <Skeleton className="aperture:h-10 aperture:w-full" />
        </div>
      ) : events.length === 0 ? (
        <Empty className="aperture:min-h-32 aperture:py-6">
          <EmptyHeader>
            <EmptyTitle>No events</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table
          className="aperture:min-w-[36rem]"
          containerClassName="aperture:max-h-[min(52svh,22rem)] aperture:flex-1"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="aperture:h-7 aperture:px-1">Event</TableHead>
              <TableHead className="aperture:h-7 aperture:px-1">Message</TableHead>
              <TableHead className="aperture:h-7 aperture:px-1 aperture:text-right">Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </TableBody>
        </Table>
      )}
      {query.hasNextPage ? (
        <div className="aperture:flex aperture:justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function EventRow({ event }: { event: ResourceEvent }) {
  return (
    <TableRow>
      <TableCell className="aperture:px-1 aperture:py-1 aperture:font-medium">
        {event.type}
      </TableCell>
      <TableCell className="aperture:max-w-md aperture:px-1 aperture:py-1 aperture:whitespace-normal aperture:text-muted-foreground">
        {event.message || "—"}
      </TableCell>
      <TableCell className="aperture:px-1 aperture:py-1 aperture:text-right aperture:text-muted-foreground">
        <time dateTime={event.createdAt}>{formatTimestamp(event.createdAt)}</time>
      </TableCell>
    </TableRow>
  );
}
