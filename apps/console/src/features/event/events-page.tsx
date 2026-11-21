import type { EventKind } from "@aperture-browser/control-api";
import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@aperture-browser/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { ABOUT, ACTOR, HAPPENED, KINDS } from "#/features/event/event-words.ts";
import {
  type Event,
  useAdministeredQuery,
  useEventsQuery,
} from "#/features/event/event.queries.ts";
import { useSessionsQuery } from "#/features/session/session.queries.ts";
import { useSnapshotsQuery } from "#/features/snapshot/snapshot.queries.ts";
import { useWorkspacesQuery } from "#/features/workspace/workspace.queries.ts";
import { told } from "#/lib/api.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** How long nothing is typed before what was typed is searched for. */
const SEARCHED_AFTER = 300;
const ALL = "all";
const KIND_ITEMS = [{ value: ALL, label: "All events" }, ...KINDS.flatMap((group) => group.kinds)];

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
  const admin = useAccountQuery().data?.admin === true;
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
    <div className="aperture:grid aperture:gap-0.5">
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
  const [kind, setKind] = useState<EventKind | typeof ALL>(ALL);
  const [search, setSearch] = useState("");
  const [actor, setActor] = useState("");
  const events = useEventsQuery({
    kind: kind === ALL ? undefined : kind,
    actor: actor === "" ? undefined : actor,
  });
  const shown = useShown();
  const listed = events.data?.pages.flatMap((page) => page.events) ?? [];

  useEffect(() => {
    const waited = setTimeout(() => setActor(search.trim()), SEARCHED_AFTER);
    return () => clearTimeout(waited);
  }, [search]);

  return (
    <TablePage>
      <PageHeaderActions>
        <Input
          data-console-events-actor
          type="search"
          placeholder="Search by actor"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="aperture:h-8 aperture:max-w-56"
        />
        <Select
          items={KIND_ITEMS}
          value={kind}
          onValueChange={(next) => {
            if (next !== null) {
              setKind(next);
            }
          }}
        >
          <SelectTrigger size="sm" aria-label="Kind of event" data-console-events-kind>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end" alignItemWithTrigger={false} className="aperture:min-w-60">
            <SelectGroup>
              <SelectItem value={ALL}>All events</SelectItem>
            </SelectGroup>
            {KINDS.map((group) => (
              <SelectGroup key={group.label}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.kinds.map((one) => (
                  <SelectItem key={one.value} value={one.value}>
                    {one.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </PageHeaderActions>
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
            {listed.map((event) => (
              <TableRow key={event.id} data-console-event={event.kind}>
                <TableCell className="aperture:whitespace-nowrap aperture:text-muted-foreground">
                  {when.format(new Date(event.at.epochMilliseconds))}
                </TableCell>
                <TableCell>
                  <div className="aperture:grid aperture:gap-0.5">
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
                <TableCell data-console-event-says>{HAPPENED[event.kind](event)}</TableCell>
                <TableCell>
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
