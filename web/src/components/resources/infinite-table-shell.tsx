import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Empty, EmptyHeader, EmptyTitle } from "#/components/ui/empty.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import type { PaginatedResponse } from "#/lib/api/pagination.ts";

type InfiniteTableShellProps<T> = {
  query: UseInfiniteQueryResult<InfiniteData<PaginatedResponse<T>>, Error>;
  emptyTitle: string;
  children: (items: T[]) => React.ReactNode;
};

export function InfiniteTableShell<T>({ query, emptyTitle, children }: InfiniteTableShellProps<T>) {
  if (query.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Failed to load data</AlertDescription>
      </Alert>
    );
  }

  const items = query.data?.pages.flatMap((page) => page.data) ?? [];

  if (items.length === 0) {
    return (
      <Empty className="min-h-48 border">
        <EmptyHeader>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-2">
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
    </div>
  );
}
