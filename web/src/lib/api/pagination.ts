import type { PageMeta } from "#/lib/api/schemas.ts";

export type PaginatedResponse<T> = {
  data: T[];
  meta: PageMeta;
};

export type ListQueryParams = {
  limit?: number;
  cursor?: string;
};

export function appendQueryParams(
  path: string,
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    search.set(key, String(value));
  }

  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function getNextPageParam<T>(page: PaginatedResponse<T>): string | undefined {
  return page.meta.hasMore ? page.meta.nextCursor : undefined;
}

export function flattenInfinitePages<T>(pages: PaginatedResponse<T>[] | undefined): T[] {
  return pages?.flatMap((page) => page.data) ?? [];
}

export const defaultListLimit = 50;

export const listQueryDefaults = {
  refetchInterval: 5_000,
  refetchOnWindowFocus: true,
} as const;
