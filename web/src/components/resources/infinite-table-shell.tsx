import { autoUpdate } from "@floating-ui/dom";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "#/components/ui/empty.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { TableCell, TableRow } from "#/components/ui/table.tsx";
import type { PaginatedResponse } from "#/lib/api/pagination.ts";

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
};

export function InfiniteTableShell<T>({
  query,
  emptyTitle,
  loading,
  children,
}: InfiniteTableShellProps<T>) {
  if (query.isLoading) {
    return <TableScrollArea>{loading}</TableScrollArea>;
  }

  if (query.isError) {
    return (
      <TableScrollArea>
        <div className="min-w-full">
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
      <TableScrollArea>
        <div className="flex h-full min-h-full min-w-full flex-1">
          <Empty className="min-h-full border">
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
    <TableScrollArea>
      {children(items)}
      {query.hasNextPage ? (
        <div className="flex justify-center pt-1">
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

function TableScrollArea({ children }: { children: React.ReactNode }) {
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
      className="relative flex h-full min-h-0 min-w-0 flex-1 [--table-scroll-padding-inline:0.75rem]"
    >
      <ScrollArea
        data-table-scroll
        scrollbars="both"
        className="h-full min-h-0 min-w-0 flex-1"
        viewportClassName="flex min-h-0 flex-col"
      >
        <div
          ref={contentRef}
          className="flex h-full min-h-full min-w-full flex-1 flex-col gap-2 px-3 pb-3"
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
