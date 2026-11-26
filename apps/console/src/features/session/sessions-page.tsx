import { Button } from "@aperture-browser/ui/components/button";
import { ButtonGroup } from "@aperture-browser/ui/components/button-group";
import { Input } from "@aperture-browser/ui/components/input";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Separator } from "@aperture-browser/ui/components/separator";
import { ToggleGroup, ToggleGroupItem } from "@aperture-browser/ui/components/toggle-group";
import {
  AppWindow,
  ChevronDown,
  Layers,
  LayoutGrid,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { filter, Filters } from "#/components/filter-menu.tsx";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { useAccess } from "#/features/auth/access.ts";
import { SessionCreateDialog } from "#/features/session/session-create-dialog.tsx";
import { SessionCard, TabCard } from "#/features/session/session-card.tsx";
import { useSessionPicture } from "#/features/session/session-picture.tsx";
import { SessionStatusBadge } from "#/features/session/session-status-badge.tsx";
import {
  useBulkSessionActionMutation,
  useOpenNewSession,
} from "#/features/session/session.mutations.ts";
import { type Session, useSessionsQuery } from "#/features/session/session.queries.ts";
import { OnlookedNote } from "#/features/workspace/onlooked-note.tsx";
import { useOnlooks, useSelectedWorkspace } from "#/features/workspace/workspace.queries.ts";
import { CARD_GRID, CardsSkeleton } from "#/components/list-skeleton.tsx";
import { told } from "#/lib/api.ts";
import { useListSearch, useSearchText } from "#/lib/list-search.ts";
import { useLast } from "#/lib/use-last.ts";
import { ListEmpty, ListNoMatch } from "#/components/list-empty.tsx";

/** What the list is narrowed and ordered by, as the page's address keeps it. */
export const SESSIONS_SEARCH = {
  q: "text",
  status: ["all", "active", "suspended", "failed"],
  sort: ["created", "label"],
  view: ["sessions", "tabs"],
} as const;

const VIEWS = [
  { value: "sessions", label: "Sessions", icon: LayoutGrid },
  { value: "tabs", label: "Tabs", icon: Layers },
] as const;

const STATUSES = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "failed", label: "Failed" },
] as const;
type Status = (typeof STATUSES)[number]["value"];

const ORDERS = [
  { value: "created", label: "Newest" },
  { value: "label", label: "Label" },
] as const;
type Order = (typeof ORDERS)[number]["value"];

const STATUS: Record<Status, (session: Session) => boolean> = {
  all: () => true,
  active: (session) =>
    ["running", "starting", "restoring", "suspending"].includes(session.observedState),
  suspended: (session) => session.observedState === "suspended",
  failed: (session) =>
    session.observedState === "failed" ||
    session.observedState === "gone" ||
    session.unreachableSince !== null,
};

/** Whether a session is one that is sought: by its label, its id, its snapshot or its tags. */
const matches = (session: Session, sought: string) =>
  [
    session.id,
    session.label ?? "",
    session.snapshotId ?? "",
    ...Object.entries(session.tags).flat(),
  ].some((text) => text.toLowerCase().includes(sought));

/** How wide the picture of a tab of the tabs' view is asked for. */
const TAB_WIDTH = 320;

/** Whether a tab is one that is sought: by its page's title or address. */
const tabMatches = (tab: { title: string; url: string }, sought: string) =>
  [tab.title, tab.url].some((text) => text.toLowerCase().includes(sought));

/**
 * A session as a row: what it is, then its tabs side by side, those that are sought, all
 * of them where the session itself is. Nothing where none is.
 */
function SessionTabs({ session, sought }: { session: Session; sought: string }) {
  const { tabs } = useSessionPicture(session, TAB_WIDTH);
  const shown =
    sought === "" || matches(session, sought)
      ? tabs
      : tabs.filter((tab) => tabMatches(tab, sought));
  if (shown.length === 0) {
    return null;
  }
  const name = session.label ?? session.id;
  return (
    <section
      data-console-session-tabs-group={session.id}
      aria-label={name}
      className="aperture:grid aperture:gap-2 aperture:rounded-xl aperture:bg-card aperture:p-2 aperture:text-card-foreground aperture:ring-1 aperture:ring-foreground/10 aperture:md:grid-cols-[12rem_minmax(0,1fr)] aperture:md:gap-0"
    >
      <div className="aperture:flex aperture:min-w-0 aperture:flex-col aperture:gap-1 aperture:px-1 aperture:pt-1 aperture:md:border-r aperture:md:border-foreground/10 aperture:md:pr-3">
        <h2 className="aperture:min-w-0 aperture:text-sm aperture:font-medium">
          <Link
            to="/-/sessions/$sessionId"
            params={{ sessionId: session.id }}
            title={name}
            className="aperture:block aperture:truncate aperture:hover:underline"
          >
            {name}
          </Link>
        </h2>
        <div className="aperture:flex aperture:flex-wrap aperture:items-center aperture:gap-2">
          <SessionStatusBadge session={session} />
          <span className="aperture:text-xs aperture:text-muted-foreground">
            {tabs.length === 1 ? "1 tab" : `${tabs.length} tabs`}
          </span>
        </div>
        <span className="aperture:truncate aperture:font-mono aperture:text-[0.7rem] aperture:text-muted-foreground/80">
          {session.id}
        </span>
      </div>
      {/* One row however many there are: the page scrolls by sessions, a row by tabs. */}
      <ul className="aperture:flex aperture:snap-x aperture:gap-1 aperture:overflow-x-auto aperture:pb-1 aperture:[scrollbar-width:thin] aperture:md:pl-2">
        {shown.map((tab) => (
          <li key={tab.tab} className="aperture:w-40 aperture:shrink-0 aperture:snap-start">
            <TabCard session={session} tab={tab} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** An account's sessions, wherever they run. */
export function SessionsPage() {
  const sessions = useSessionsQuery();
  const openNew = useOpenNewSession();
  const suspend = useBulkSessionActionMutation("suspend");
  const resume = useBulkSessionActionMutation("resume");
  const remove = useBulkSessionActionMutation("delete");
  const workspace = useSelectedWorkspace();
  const access = useAccess();
  const onlooks = useOnlooks()(workspace?.id ?? null);
  const writes = access.may("sessions:write") && !onlooks;
  const [{ q, status, sort: order, view }, setList] = useListSearch(SESSIONS_SEARCH);
  const [search, setSearch] = useSearchText(q, (text) => setList({ q: text }));
  const setStatus = (next: Status) => setList({ status: next });
  const setOrder = (next: Order) => setList({ sort: next });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** How many sessions are asked to be deleted, while that is asked. */
  const [confirming, setConfirming] = useState<number>();
  const deleted = useLast(confirming);
  const [creating, setCreating] = useState(false);
  /** Whether the field to search by is open, where it is not always there. */
  const [searching, setSearching] = useState(q !== "");
  const searchInput = useRef<HTMLInputElement>(null);
  /** Where a range that Shift extends starts. */
  const anchor = useRef<string>(undefined);

  const sought = search.trim().toLowerCase();
  const owned = (sessions.data ?? []).filter(
    (session) => session.workspaceId === (workspace?.id ?? null),
  );
  const ordered = owned
    .filter((session) => STATUS[status](session))
    .toSorted((one, other) =>
      order === "label"
        ? (one.label ?? one.id).localeCompare(other.label ?? other.id)
        : other.createdAt.epochMilliseconds - one.createdAt.epochMilliseconds,
    );
  const shown = ordered.filter((session) => sought === "" || matches(session, sought));
  // What is selected and no longer shown is not acted on.
  const chosen = (view === "tabs" ? [] : shown)
    .filter((session) => selected.has(session.id))
    .map((session) => session.id);

  useHotkey("Mod+F", () => searchInput.current?.focus());
  // A dialog or menu open over the list has Escape too; the selection goes all the same.
  useHotkey("Escape", () => setSelected(new Set()), {
    preventDefault: false,
    stopPropagation: false,
    conflictBehavior: "allow",
  });

  const select = (id: string, on: boolean, range: boolean) => {
    const next = new Set(selected);
    const from = shown.findIndex((session) => session.id === anchor.current);
    const to = shown.findIndex((session) => session.id === id);
    const ids =
      range && from !== -1
        ? shown.slice(Math.min(from, to), Math.max(from, to) + 1).map((session) => session.id)
        : [id];
    for (const one of ids) {
      if (on) {
        next.add(one);
      } else {
        next.delete(one);
      }
    }
    anchor.current = id;
    setSelected(next);
  };

  const makes = access.makesSessionsIn(workspace?.id ?? null) && !onlooks;
  const openPlain = () => void openNew(workspace === null ? {} : { workspaceId: workspace.id });
  const narrowed = sought !== "" || status !== "all";
  const clearFilters = () => {
    setSearch("");
    setSearching(false);
    setList({ q: "", status: "all" });
  };

  const busy = suspend.isPending || resume.isPending || remove.isPending;
  const clear = { onSettled: () => setSelected(new Set()) };

  return (
    <div className="aperture:relative aperture:flex aperture:h-full aperture:flex-col">
      <PageHeaderActions>
        <Input
          ref={searchInput}
          type="search"
          aria-label={view === "tabs" ? "Search tabs" : "Search sessions"}
          placeholder={view === "tabs" ? "Search tabs" : "Search sessions"}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="aperture:h-8 aperture:max-w-56 aperture:max-sm:hidden"
        />
        {/* A phone's title bar has no room for the field: it opens below the bar. */}
        <Button
          size="icon-sm"
          variant={searching || sought !== "" ? "secondary" : "ghost"}
          aria-label="Search sessions"
          aria-expanded={searching}
          data-console-search-open
          className="aperture:sm:hidden"
          onClick={() => setSearching(!searching)}
        >
          <Search />
        </Button>
        <ToggleGroup
          aria-label="What the grid shows"
          variant="outline"
          size="sm"
          spacing={0}
          value={[view]}
          // One of the two is always chosen: pressing the chosen one leaves it so.
          onValueChange={([next]) =>
            setList({ view: VIEWS.find((one) => one.value === next)?.value ?? view })
          }
        >
          {VIEWS.map((one) => (
            <ToggleGroupItem
              key={one.value}
              value={one.value}
              aria-label={one.label}
              data-console-sessions-view={one.value}
            >
              <one.icon />
              <span className="aperture:max-md:sr-only">{one.label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Filters
          filters={[
            filter({ label: "Status", value: status, options: STATUSES, onChange: setStatus }),
            filter({ label: "Sort", value: order, options: ORDERS, onChange: setOrder }),
          ]}
        />
        {makes ? (
          <ButtonGroup>
            <Button data-console-create size="sm" aria-label="New session" onClick={openPlain}>
              <Plus />
              <span className="aperture:max-sm:hidden">New session</span>
            </Button>
            <Button
              data-console-create-custom
              size="icon-sm"
              aria-label="New session with options"
              className="aperture:border-l-primary-foreground/20!"
              onClick={() => setCreating(true)}
            >
              <ChevronDown />
            </Button>
          </ButtonGroup>
        ) : null}
      </PageHeaderActions>
      {searching ? (
        <div className="aperture:flex aperture:shrink-0 aperture:gap-1 aperture:border-b aperture:p-2 aperture:sm:hidden">
          <Input
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions"
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
      <ScrollArea
        className="aperture:min-h-0 aperture:flex-1"
        viewportClassName="aperture:flex aperture:flex-col"
      >
        <div className="aperture:flex aperture:flex-1 aperture:flex-col aperture:gap-4 aperture:p-4 aperture:max-sm:p-3">
          <OnlookedNote />
          {sessions.isError ? (
            <p role="alert" className="aperture:text-sm aperture:text-destructive">
              {told(sessions.error)}
            </p>
          ) : null}
          {sessions.isPending ? (
            <CardsSkeleton />
          ) : sessions.data !== undefined && (view === "tabs" ? ordered : shown).length === 0 ? (
            owned.length > 0 && narrowed ? (
              <ListNoMatch title="No session matches" onClear={clearFilters} />
            ) : (
              <ListEmpty icon={AppWindow} title="No sessions yet">
                {makes ? (
                  <Button size="sm" onClick={openPlain}>
                    <Plus />
                    New session
                  </Button>
                ) : null}
              </ListEmpty>
            )
          ) : view === "tabs" ? (
            <div data-console-tabs className="aperture:grid aperture:gap-3">
              {ordered.map((session) => (
                <SessionTabs key={session.id} session={session} sought={sought} />
              ))}
            </div>
          ) : (
            <div className={CARD_GRID}>
              {shown.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  selected={selected.has(session.id)}
                  // What is done with the selected is all a change to them.
                  onSelect={writes ? (on, range) => select(session.id, on, range) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
      {chosen.length > 0 ? (
        // Over the middle of the page, whatever the sidebar takes of the window, and at
        // hand however far the sessions are scrolled.
        <div className="aperture:pointer-events-none aperture:absolute aperture:inset-x-3 aperture:bottom-5 aperture:z-40 aperture:flex aperture:justify-center">
          <div
            data-console-bulk
            role="toolbar"
            aria-label="Selected sessions"
            className="aperture:pointer-events-auto aperture:flex aperture:min-h-9 aperture:max-w-full aperture:animate-in aperture:items-center aperture:gap-2 aperture:rounded-lg aperture:bg-popover aperture:px-2 aperture:py-1 aperture:text-popover-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10 aperture:duration-150 aperture:fade-in-0 aperture:slide-in-from-bottom-2"
          >
            <span className="aperture:pl-1 aperture:text-sm aperture:whitespace-nowrap aperture:text-muted-foreground">
              {chosen.length} selected
            </span>
            <Separator
              orientation="vertical"
              className="aperture:data-vertical:h-5 aperture:data-vertical:self-center"
            />
            <div className="aperture:flex aperture:items-center aperture:gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => suspend.mutate(chosen, clear)}
              >
                <Pause />
                <span className="aperture:max-sm:sr-only">Suspend</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => resume.mutate(chosen, clear)}
              >
                <Play />
                <span className="aperture:max-sm:sr-only">Resume</span>
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => setConfirming(chosen.length)}
              >
                <Trash2 />
                <span className="aperture:max-sm:sr-only">Delete</span>
              </Button>
            </div>
            <Separator
              orientation="vertical"
              className="aperture:data-vertical:h-5 aperture:data-vertical:self-center"
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label="Clear selection"
              onClick={() => setSelected(new Set())}
            >
              <X />
              <span className="aperture:max-sm:sr-only">Clear</span>
            </Button>
          </div>
        </div>
      ) : null}
      <SessionCreateDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={confirming !== undefined}
        title={deleted === 1 ? "Delete this session?" : `Delete ${deleted ?? 0} sessions?`}
        description="Their profiles and files are removed. Snapshots taken of them stay."
        confirmLabel="Delete"
        variant="destructive"
        pending={remove.isPending}
        onOpenChange={(open) => (open ? undefined : setConfirming(undefined))}
        onConfirm={() =>
          chosen.length === 0 || remove.isPending
            ? undefined
            : remove.mutate(chosen, {
                onSettled: () => {
                  setConfirming(undefined);
                  setSelected(new Set());
                },
              })
        }
      />
    </div>
  );
}
