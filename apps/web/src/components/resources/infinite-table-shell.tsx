import { autoUpdate } from "@floating-ui/dom";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Alert, AlertDescription } from "@aperture-browser/ui/components/alert";
import { Button } from "@aperture-browser/ui/components/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@aperture-browser/ui/components/empty";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Skeleton } from "@aperture-browser/ui/components/skeleton";
import { TableCell, TableRow } from "@aperture-browser/ui/components/table";
import type { PaginatedResponse } from "@aperture-browser/api-client";
import { cn } from "@aperture-browser/ui/utils";

type TableSkeletonColumn = {
  cellClassName?: string;
  skeletonClassName: string;
  sticky?: "start" | "end";
};

type InfiniteTableShellProps<T> = {
  query: UseInfiniteQueryResult<InfiniteData<PaginatedResponse<T>>, Error>;
  emptyTitle: string;
  loading: React.ReactNode;
  children: (items: T[]) => React.ReactNode;
  className?: string;
};

export function InfiniteTableShell<T>({
  query,
  emptyTitle,
  loading,
  children,
  className,
}: InfiniteTableShellProps<T>) {
  if (query.isLoading) {
    return <TableScrollArea className={className}>{loading}</TableScrollArea>;
  }

  if (query.isError) {
    return (
      <TableScrollArea className={className}>
        <div className="aperture:min-w-full">
          <Alert variant="destructive">
            <AlertDescription>Failed to load data</AlertDescription>
          </Alert>
        </div>
      </TableScrollArea>
    );
  }

  const items = query.data?.pages.flatMap((page) => page.data) ?? [];

  if (items.length === 0) {
    return (
      <TableScrollArea className={className}>
        <div className="aperture:flex aperture:h-full aperture:min-h-full aperture:min-w-full aperture:flex-1">
          <Empty className="aperture:min-h-full aperture:border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>{emptyTitle}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        </div>
      </TableScrollArea>
    );
  }

  return (
    <TableScrollArea className={className}>
      {children(items)}
      {query.hasNextPage ? (
        <div className="aperture:flex aperture:justify-center aperture:pt-1">
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
    </TableScrollArea>
  );
}

function TableScrollArea({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const shell = rootRef.current;
    const root = shell?.querySelector<HTMLElement>("[data-table-scroll]");
    const viewport = root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const content = contentRef.current;
    if (!shell || !root || !viewport || !content) {
      return;
    }

    const scrollShell = shell;
    const scrollViewport = viewport;
    function updateScrollState() {
      const maxScrollLeft = Math.max(0, scrollViewport.scrollWidth - scrollViewport.clientWidth);
      const canScrollLeft = scrollViewport.scrollLeft > 1 ? "true" : "false";
      const canScrollRight = scrollViewport.scrollLeft < maxScrollLeft - 1 ? "true" : "false";
      scrollShell.dataset.canScrollTop = scrollViewport.scrollTop > 1 ? "true" : "false";
      scrollShell.dataset.canScrollLeft = canScrollLeft;
      scrollShell.dataset.canScrollRight = canScrollRight;
    }

    updateScrollState();
    const cleanupAutoUpdate = autoUpdate(scrollViewport, content, updateScrollState);
    scrollViewport.addEventListener("scroll", updateScrollState, { passive: true });

    return () => {
      cleanupAutoUpdate();
      scrollViewport.removeEventListener("scroll", updateScrollState);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      data-table-scroll-shell
      data-can-scroll-top="false"
      data-can-scroll-left="false"
      data-can-scroll-right="false"
      className={cn(
        "aperture:relative aperture:flex aperture:h-full aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:[--table-scroll-padding-inline:0.75rem]",
        className,
      )}
    >
      <ScrollArea
        data-table-scroll
        scrollbars="both"
        className="aperture:h-full aperture:min-h-0 aperture:min-w-0 aperture:flex-1"
        viewportClassName="aperture:flex aperture:min-h-0 aperture:flex-col"
      >
        <div
          ref={contentRef}
          className="aperture:flex aperture:h-full aperture:min-h-full aperture:min-w-full aperture:flex-1 aperture:flex-col aperture:gap-2 aperture:px-3 aperture:pb-3"
        >
          {children}
        </div>
      </ScrollArea>
      <div data-table-header-shadow aria-hidden="true" />
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
            <TableCell
              key={columnIndex}
              data-table-sticky={column.sticky}
              className={column.cellClassName}
            >
              <Skeleton className={column.skeletonClassName} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
