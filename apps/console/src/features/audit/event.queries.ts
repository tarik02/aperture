import type { EventKind } from "@aperture-browser/control-api";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { queryKeys } from "#/lib/query-keys.ts";

/** Which events a page asks for; all its account reads, where nothing is said. */
export interface EventsFilters {
  readonly kind?: EventKind | undefined;
  /** A part of what the actor was called, or an account's id. */
  readonly actor?: string | undefined;
}

/** How many events a page of them holds. */
const PAGE = 50;

const listEvents = (filters: EventsFilters, cursor: string | undefined) =>
  call((api) =>
    api.events.list({
      query: {
        limit: PAGE,
        ...(filters.kind === undefined ? {} : { kind: filters.kind }),
        ...(filters.actor === undefined ? {} : { actor: filters.actor }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  );

export type Event = Awaited<ReturnType<typeof listEvents>>["events"][number];

/** Events, the newest first, a page at a time: the pages before are asked for one by one. */
export function useEventsQuery(filters: EventsFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.events(filters),
    queryFn: ({ pageParam }) => listEvents(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next ?? undefined,
  });
}

/**
 * The accounts and the nodes there are, for telling which of them an event is about still
 * exist. An admin alone is told of them, so nobody else asks.
 */
export function useAdministeredQuery(admin: boolean) {
  const accounts = useQuery({
    queryKey: queryKeys.accounts,
    queryFn: () => call((api) => api.accounts.list()),
    enabled: admin,
  });
  const nodes = useQuery({
    queryKey: queryKeys.nodes,
    queryFn: () => call((api) => api.nodes.list()),
    enabled: admin,
  });
  return { accounts: accounts.data, nodes: nodes.data };
}
