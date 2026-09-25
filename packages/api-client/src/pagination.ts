import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { ApiCredentials } from "./authorization/service.ts";
import type { ApiRequestError } from "./errors.ts";
import type { PageMeta } from "./schemas.ts";

export interface PaginatedResponse<T> {
  readonly data: ReadonlyArray<T>;
  readonly meta: PageMeta;
}

/** The opaque `nextCursor` of the previous page, sent along with the same filter. */
export interface PageCursor {
  cursor?: string;
}

/**
 * The calls every cursor-paginated list exposes. The filter's `limit` is the page size.
 * `list` fetches one page; `stream` fetches pages only as the stream is pulled; `listAll`
 * collects every page.
 */
export interface PaginatedList<Filter, T> {
  readonly list: (
    credentials: ApiCredentials,
    params?: Filter & PageCursor,
  ) => Effect.Effect<PaginatedResponse<T>, ApiRequestError>;
  readonly stream: (
    credentials: ApiCredentials,
    filter?: Filter,
  ) => Stream.Stream<T, ApiRequestError>;
  readonly listAll: (
    credentials: ApiCredentials,
    filter?: Filter,
  ) => Effect.Effect<ReadonlyArray<T>, ApiRequestError>;
}

export function getNextPageParam<T>(page: PaginatedResponse<T>): string | undefined {
  return page.meta.hasMore ? page.meta.nextCursor : undefined;
}

export function flattenInfinitePages<T>(pages: PaginatedResponse<T>[] | undefined): T[] {
  return pages?.flatMap((page) => page.data) ?? [];
}

/**
 * Derives `stream` and `listAll` from the call that fetches one page. That call must also
 * accept a bare cursor, which every filter allows because all its fields are optional.
 */
export function paginated<Filter, T>(
  list: (
    credentials: ApiCredentials,
    params?: (Filter & PageCursor) | PageCursor,
  ) => Effect.Effect<PaginatedResponse<T>, ApiRequestError>,
): PaginatedList<Filter, T> {
  const stream = (credentials: ApiCredentials, filter?: Filter) =>
    Stream.paginate<string | undefined, T, ApiRequestError>(undefined, (cursor) =>
      list(credentials, filter === undefined ? { cursor } : { ...filter, cursor }).pipe(
        Effect.map((page) => {
          const next = getNextPageParam(page);
          return [page.data, next === undefined ? Option.none() : Option.some(next)] as const;
        }),
      ),
    );

  const listAll = (credentials: ApiCredentials, filter?: Filter) =>
    Stream.runCollect(stream(credentials, filter));

  return { list, stream, listAll };
}

export const defaultListLimit = 50;

export const listQueryDefaults = {
  refetchOnWindowFocus: true,
} as const;
