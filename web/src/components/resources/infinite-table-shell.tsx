import { autoUpdate } from "@floating-ui/dom";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Empty, EmptyHeader, EmptyTitle } from "#/components/ui/empty.tsx";
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
        <div className="min-w-full">
          <Empty className="min-h-48 border">
            <EmptyHeader>
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

  useEffect(() => {
    const root = rootRef.current?.querySelector<HTMLElement>("[data-table-scroll]");
    const viewport = root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const content = contentRef.current;
    if (!root || !viewport || !content) {
      return;
    }

    const scrollRoot = root;
    const scrollViewport = viewport;
    let animationFrame: number | null = null;

    function updateScrollState() {
      const maxScrollLeft = Math.max(0, scrollViewport.scrollWidth - scrollViewport.clientWidth);
      scrollRoot.dataset.canScrollLeft = scrollViewport.scrollLeft > 1 ? "true" : "false";
      scrollRoot.dataset.canScrollRight =
        scrollViewport.scrollLeft < maxScrollLeft - 1 ? "true" : "false";
    }

    function scheduleUpdate() {
      if (animationFrame !== null) {
        return;
      }

      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        updateScrollState();
      });
    }

    const cleanupAutoUpdate = autoUpdate(scrollViewport, content, scheduleUpdate);
    scrollViewport.addEventListener("scroll", scheduleUpdate, { passive: true });
    scheduleUpdate();

    return () => {
      cleanupAutoUpdate();
      scrollViewport.removeEventListener("scroll", scheduleUpdate);
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
      }
    };
  }, []);

  return (
    <div ref={rootRef} className="contents">
      <ScrollArea
        data-table-scroll
        data-can-scroll-left="false"
        data-can-scroll-right="false"
        scrollbars="both"
        className="min-h-0 flex-1 [--table-scroll-padding-inline:0.75rem]"
      >
        <div ref={contentRef} className="flex min-w-full flex-col gap-2 px-3 pb-3">
          {children}
        </div>
      </ScrollArea>
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
