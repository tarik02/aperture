import type { PageMeta } from "./schemas.ts";

export type PaginatedResponse<T> = {
  readonly data: ReadonlyArray<T>;
  readonly meta: PageMeta;
};

export type ListQueryParams = {
  limit?: number;
  cursor?: string;
};

export function getNextPageParam<T>(page: PaginatedResponse<T>): string | undefined {
  return page.meta.hasMore ? page.meta.nextCursor : undefined;
}

export function flattenInfinitePages<T>(pages: PaginatedResponse<T>[] | undefined): T[] {
  return pages?.flatMap((page) => page.data) ?? [];
}

export const defaultListLimit = 50;

export const listQueryDefaults = {
  refetchOnWindowFocus: true,
} as const;
