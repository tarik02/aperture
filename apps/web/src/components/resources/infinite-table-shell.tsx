import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { Alert, AlertDescription } from "@aperture-browser/ui/components/alert";
import { Button } from "@aperture-browser/ui/components/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@aperture-browser/ui/components/empty";
import { Skeleton } from "@aperture-browser/ui/components/skeleton";
import { TableCell, TableRow } from "@aperture-browser/ui/components/table";
import type { PaginatedResponse } from "@aperture-browser/api-client";
import { cn } from "@aperture-browser/ui/utils";

type TableSkeletonColumn = {
  cellClassName?: string;
  skeletonClassName: string;
};

type InfiniteTableShellProps<T> = {
  query: UseInfiniteQueryResult<InfiniteData<PaginatedResponse<T>>, Error>;
  emptyTitle: string;
  loading: React.ReactNode;
  children: (items: T[]) => React.ReactNode;
  className?: string;
};

/**
 * Lays out a paginated table below the page filters. The table shrinks to the remaining
 * height and scrolls itself; "Load more" stays visible underneath it.
 */
export function InfiniteTableShell<T>({
  query,
  emptyTitle,
  loading,
  children,
  className,
}: InfiniteTableShellProps<T>) {
  const items = query.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <div
      className={cn(
        "aperture:flex aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-2 aperture:px-3 aperture:pb-3",
        className,
      )}
    >
      {query.isLoading ? (
        loading
      ) : query.isError ? (
        <Alert variant="destructive">
          <AlertDescription>Failed to load data</AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <Empty className="aperture:flex-1 aperture:border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>{emptyTitle}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {children(items)}
          {query.hasNextPage ? (
            <div className="aperture:flex aperture:shrink-0 aperture:justify-center">
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
        </>
      )}
    </div>
  );
}

export function TableSkeletonRows({
  columns,
  rows = 8,
}: {
  columns: readonly TableSkeletonColumn[];
  rows?: number;
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <TableRow key={rowIndex} aria-hidden="true">
          {columns.map((column, columnIndex) => (
            <TableCell key={columnIndex} className={column.cellClassName}>
              <Skeleton className={column.skeletonClassName} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
