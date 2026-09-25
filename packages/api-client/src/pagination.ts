import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { PageMeta } from "./schemas.ts";

export interface PaginatedResponse<T> {
  readonly data: ReadonlyArray<T>;
  readonly meta: PageMeta;
}

export interface ListQueryParams {
  limit?: number;
  cursor?: string;
}

export function getNextPageParam<T>(page: PaginatedResponse<T>): string | undefined {
  return page.meta.hasMore ? page.meta.nextCursor : undefined;
}

export function flattenInfinitePages<T>(pages: PaginatedResponse<T>[] | undefined): T[] {
  return pages?.flatMap((page) => page.data) ?? [];
}

/**
 * Streams every item of a cursor-paginated list. Each page is fetched only when the stream
 * needs more items, with the same filters and the previous page's cursor.
 */
export function paginate<P extends ListQueryParams, T, E>(
  params: P,
  listPage: (params: P) => Effect.Effect<PaginatedResponse<T>, E>,
): Stream.Stream<T, E> {
  return Stream.paginate(params, (pageParams) =>
    listPage(pageParams).pipe(
      Effect.map((page) => {
        const cursor = getNextPageParam(page);
        const next =
          cursor === undefined ? Option.none<P>() : Option.some<P>({ ...params, cursor });
        return [page.data, next] as const;
      }),
    ),
  );
}

export const defaultListLimit = 50;

export const listQueryDefaults = {
  refetchOnWindowFocus: true,
} as const;
