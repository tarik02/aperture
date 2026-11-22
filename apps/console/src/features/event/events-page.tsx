import type { EventKind } from "@aperture-browser/control-api";
import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import { Link } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { useState } from "react";
import { filter, Filters } from "#/components/filter-menu.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { useMay } from "#/features/auth/access.ts";
import { ABOUT, ACTOR, HAPPENED, KINDS } from "#/features/event/event-words.ts";
import {
  type Event,
  useAdministeredQuery,
  useEventsQuery,
} from "#/features/event/event.queries.ts";
import { useSessionsQuery } from "#/features/session/session.queries.ts";
import { useSnapshotsQuery } from "#/features/snapshot/snapshot.queries.ts";
import { useWorkspacesQuery } from "#/features/workspace/workspace.queries.ts";
import { TableRowsSkeleton } from "#/components/list-skeleton.tsx";
import { told } from "#/lib/api.ts";
import { type ListSearchShape, useListSearch, useSearchText } from "#/lib/list-search.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

const ALL = "all";
const EVERY_KIND = [{ value: ALL, label: "All events" }] as const;
/** Which events are listed, as the page's address keeps it. */
export const EVENTS_SEARCH = {
  kind: [ALL, ...KINDS.flatMap((group) => group.kinds.map((one) => one.value))],
  actor: "text",
} as const satisfies ListSearchShape;

const KIND_GROUPS = KINDS.map((group) => ({ label: group.label, options: group.kinds }));

/** Where the console shows what an event is about; nowhere for what has no page of its own. */
type Shown =
  | { readonly to: "/-/sessions/$sessionId"; readonly params: { readonly sessionId: string } }
  | {
      readonly to:
        | "/-/snapshots"
        | "/-/workspaces"
        | "/-/nodes"
        | "/-/people"
        | "/-/service-accounts";
    };

/**
 * Finds where what an event is about is shown, while it still exists: an event outlives
 * what it is about, and then names it without leading anywhere.
 */
function useShown() {
  const admin = useMay("admin");
  const sessions = useSessionsQuery().data;
  const snapshots = useSnapshotsQuery().data;
  const workspaces = useWorkspacesQuery().data;
  const { accounts, nodes } = useAdministeredQuery(admin);

  return (event: Event): Shown | undefined => {
    const about = event.resource;
    if (about === null) {
      return undefined;
    }
    const session = (id: unknown): Shown | undefined =>
      sessions?.some((one) => one.id === id) === true && typeof id === "string"
        ? { to: "/-/sessions/$sessionId", params: { sessionId: id } }
        : undefined;
    switch (about.kind) {
      case "session":
        return session(about.id);
      // A link is shown where its session is.
      case "share":
        return session(event.detail["sessionId"]);
      case "snapshot":
        return snapshots?.some((one) => one.id === about.id) === true
          ? { to: "/-/snapshots" }
          : undefined;
      case "workspace":
        return workspaces?.some((one) => one.id === about.id) === true
          ? { to: "/-/workspaces" }
          : undefined;
      case "node":
        return nodes?.some((one) => one.id === about.id) === true ? { to: "/-/nodes" } : undefined;
      case "account": {
        const account = accounts?.find((one) => one.id === about.id);
        return account === undefined
          ? undefined
          : { to: account.kind === "person" ? "/-/people" : "/-/service-accounts" };
      }
      default:
        return undefined;
    }
  };
}

/** What an event is about: what it was called then, as a way to it while it is there. */
function About({ event, shown }: { event: Event; shown: Shown | undefined }) {
  const about = event.resource;
  if (about === null) {
    return <span className="aperture:text-muted-foreground">—</span>;
  }
  const name = about.label ?? about.id;
  return (
    <div className="aperture:grid aperture:gap-0.5 aperture:max-sm:inline-flex aperture:max-sm:flex-wrap aperture:max-sm:items-baseline aperture:max-sm:gap-x-2">
      {shown === undefined ? (
        <span className="aperture:max-w-72 aperture:truncate" title={name}>
          {name}
        </span>
      ) : (
        <Link
          {...shown}
          data-console-event-link
          className="aperture:max-w-72 aperture:truncate aperture:font-medium aperture:underline-offset-4 aperture:hover:underline"
          title={name}
        >
          {name}
        </Link>
      )}
      <span className="aperture:text-xs aperture:text-muted-foreground">{ABOUT[about.kind]}</span>
    </div>
  );
}

/**
 * What was done by whom, the newest first: all of it for an admin, and for anyone else what
 * is their own account's and their workspaces'.
 */
export function EventsPage() {
  // What is searched for is asked of the control plane once the typing rests, as the
  // address says it.
  const [{ kind, actor }, setList] = useListSearch(EVENTS_SEARCH);
  const [search, setSearch] = useSearchText(actor, (text) => setList({ actor: text }));
  const setKind = (next: EventKind | typeof ALL) => setList({ kind: next });
  /** Whether the field to search by is open, where it is not always there. */
  const [searching, setSearching] = useState(actor !== "");
  const events = useEventsQuery({
    kind: kind === ALL ? undefined : kind,
    actor: actor === "" ? undefined : actor,
  });
  const shown = useShown();
  const listed = events.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <TablePage>
      <PageHeaderActions>
        <Input
          data-console-events-actor
          type="search"
          aria-label="Search by actor"
          placeholder="Search by actor"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="aperture:h-8 aperture:max-w-56 aperture:max-sm:hidden"
        />
        {/* A phone's title bar has no room for the field: it opens below the bar. */}
        <Button
          size="icon-sm"
          variant={searching || search.trim() !== "" ? "secondary" : "ghost"}
          aria-label="Search by actor"
          aria-expanded={searching}
          data-console-search-open
          className="aperture:sm:hidden"
          onClick={() => setSearching(!searching)}
        >
          <Search />
        </Button>
        <Filters
          filters={[
            filter<EventKind | typeof ALL>({
              label: "Kind of event",
              value: kind,
              options: EVERY_KIND,
              groups: KIND_GROUPS,
              onChange: setKind,
            }),
          ]}
        />
      </PageHeaderActions>
      {searching ? (
        <div className="aperture:flex aperture:shrink-0 aperture:gap-1 aperture:sm:hidden">
          <Input
            type="search"
            aria-label="Search by actor"
            placeholder="Search by actor"
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close the search"
            onClick={() => {
              setSearch("");
              setSearching(false);
            }}
          >
            <X />
          </Button>
        </div>
      ) : null}
      {events.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(events.error)}
        </p>
      ) : events.isSuccess && listed.length === 0 ? (
        <p
          data-console-empty
          className="aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
        >
          No events.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>About</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.isPending ? <TableRowsSkeleton columns={4} twoLines /> : null}
            {listed.map((event) => (
              <TableRow key={event.id} data-console-event={event.kind}>
                {/* On a phone what happened leads the row's block, and when ends it. */}
                <TableCell className="aperture:whitespace-nowrap aperture:text-muted-foreground aperture:max-sm:order-last aperture:max-sm:text-xs">
                  {when.format(new Date(event.at.epochMilliseconds))}
                </TableCell>
                <TableCell label="By" className="aperture:max-sm:basis-full">
                  <div className="aperture:grid aperture:gap-0.5 aperture:max-sm:inline-flex aperture:max-sm:flex-wrap aperture:max-sm:items-baseline aperture:max-sm:gap-x-2">
                    <span
                      className={
                        event.actor.name === null
                          ? "aperture:text-muted-foreground"
                          : "aperture:font-medium"
                      }
                    >
                      {event.actor.name ?? ACTOR[event.actor.kind]}
                    </span>
                    {event.address === null ? null : (
                      <span className="aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
                        {event.address}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell
                  data-console-event-says
                  className="aperture:max-sm:order-first aperture:max-sm:basis-full aperture:max-sm:font-medium"
                >
                  {HAPPENED[event.kind](event)}
                </TableCell>
                <TableCell label="About" className="aperture:max-sm:basis-full">
                  <About event={event} shown={shown(event)} />
                </TableCell>
              </TableRow>
            ))}
            {events.hasNextPage ? (
              <TableRow>
                <TableCell colSpan={4} className="aperture:text-center">
                  <Button
                    data-console-events-more
                    size="sm"
                    variant="outline"
                    disabled={events.isFetchingNextPage}
                    onClick={() => void events.fetchNextPage()}
                  >
                    Load more
                  </Button>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}
    </TablePage>
  );
}
