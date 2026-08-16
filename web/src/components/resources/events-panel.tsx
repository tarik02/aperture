import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import { formatTimestamp } from "#/lib/format.ts";
import type { ResourceEvent } from "#/lib/api/schemas.ts";
import { useEventsInfiniteQuery } from "#/features/event/event.queries.ts";
import { Button } from "#/components/ui/button.tsx";
import { Empty, EmptyHeader, EmptyTitle } from "#/components/ui/empty.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table.tsx";
import { cn } from "#/lib/utils.ts";

type EventsPanelProps = {
  resourceType: string;
  resourceId: string;
  className?: string;
};

export function EventsPanel({ resourceType, resourceId, className }: EventsPanelProps) {
  const query = useEventsInfiniteQuery({ resourceType, resourceId, limit: 20 });
  const events = flattenInfinitePages(query.data?.pages);

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      {query.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : events.length === 0 ? (
        <Empty className="min-h-32 py-6">
          <EmptyHeader>
            <EmptyTitle>No events</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea
          className="min-h-0 max-h-[min(52svh,22rem)] flex-1"
          viewportClassName="pb-2 data-[has-overflow-y]:pr-3"
          scrollbars="both"
        >
          <Table className="min-w-[36rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="h-7 px-1">Event</TableHead>
                <TableHead className="h-7 px-1">Message</TableHead>
                <TableHead className="h-7 px-1 text-right">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      )}
      {query.hasNextPage ? (
        <div className="flex justify-center">
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
      <TableCell className="px-1 py-1 font-medium">{event.type}</TableCell>
      <TableCell className="max-w-md px-1 py-1 whitespace-normal text-muted-foreground">
        {event.message || "—"}
      </TableCell>
      <TableCell className="px-1 py-1 text-right text-muted-foreground">
        <time dateTime={event.createdAt}>{formatTimestamp(event.createdAt)}</time>
      </TableCell>
    </TableRow>
  );
}
