import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import { ChevronDown, Pause, Play, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Choice } from "#/components/choice.tsx";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SessionCreateDialog } from "#/features/session/session-create-dialog.tsx";
import { SessionCard } from "#/features/session/session-card.tsx";
import {
  useBulkSessionActionMutation,
  useOpenNewSession,
} from "#/features/session/session.mutations.ts";
import { type Session, useSessionsQuery } from "#/features/session/session.queries.ts";
import { useSelectedWorkspace } from "#/features/workspace/workspace.queries.ts";
import { told } from "#/lib/api.ts";
import { useLast } from "#/lib/use-last.ts";

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
  active: (session) => ["running", "starting", "suspending"].includes(session.observedState),
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

/** An account's sessions, wherever they run. */
export function SessionsPage() {
  const sessions = useSessionsQuery();
  const openNew = useOpenNewSession();
  const suspend = useBulkSessionActionMutation("suspend");
  const resume = useBulkSessionActionMutation("resume");
  const remove = useBulkSessionActionMutation("delete");
  const workspace = useSelectedWorkspace();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [order, setOrder] = useState<Order>("created");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** How many sessions are asked to be deleted, while that is asked. */
  const [confirming, setConfirming] = useState<number>();
  const deleted = useLast(confirming);
  const [creating, setCreating] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  /** Where a range that Shift extends starts. */
  const anchor = useRef<string>(undefined);

  const sought = search.trim().toLowerCase();
  const shown = (sessions.data ?? [])
    .filter(
      (session) =>
        session.workspaceId === (workspace?.id ?? null) &&
        STATUS[status](session) &&
        (sought === "" || matches(session, sought)),
    )
    .toSorted((one, other) =>
      order === "label"
        ? (one.label ?? one.id).localeCompare(other.label ?? other.id)
        : other.createdAt.epochMilliseconds - one.createdAt.epochMilliseconds,
    );
  // What is selected and no longer shown is not acted on.
  const chosen = shown.filter((session) => selected.has(session.id)).map((session) => session.id);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "f") {
        event.preventDefault();
        searchInput.current?.focus();
      } else if (event.key === "Escape") {
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const busy = suspend.isPending || resume.isPending || remove.isPending;
  const clear = { onSettled: () => setSelected(new Set()) };

  return (
    <div className="aperture:flex aperture:flex-col aperture:gap-4 aperture:p-4">
      <PageHeaderActions>
        <Input
          ref={searchInput}
          type="search"
          placeholder="Search sessions"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="aperture:h-8 aperture:max-w-56"
        />
        <Choice
          size="sm"
          aria-label="Status"
          value={status}
          options={STATUSES}
          onChange={setStatus}
        />
        <Choice size="sm" aria-label="Sort" value={order} options={ORDERS} onChange={setOrder} />
        <div className="aperture:flex">
          <Button
            data-console-create
            size="sm"
            className="aperture:rounded-r-none"
            onClick={() => void openNew(workspace === null ? {} : { workspaceId: workspace.id })}
          >
            <Plus />
            New session
          </Button>
          <Button
            data-console-create-custom
            size="icon-sm"
            aria-label="New session with options"
            className="aperture:rounded-l-none aperture:border-l-primary-foreground/20"
            onClick={() => setCreating(true)}
          >
            <ChevronDown />
          </Button>
        </div>
      </PageHeaderActions>
      {chosen.length > 0 ? (
        <div
          data-console-bulk
          role="toolbar"
          aria-label="Selected sessions"
          // Floats over the sessions, where it is at hand however far the page is scrolled.
          className="aperture:fixed aperture:bottom-6 aperture:left-1/2 aperture:z-40 aperture:flex aperture:max-w-[calc(100vw-2rem)] aperture:-translate-x-1/2 aperture:animate-in aperture:items-center aperture:gap-2 aperture:rounded-full aperture:border aperture:bg-popover aperture:py-1.5 aperture:pr-1.5 aperture:pl-4 aperture:text-sm aperture:text-popover-foreground aperture:shadow-lg aperture:duration-150 aperture:fade-in-0 aperture:slide-in-from-bottom-4"
        >
          <span className="aperture:pr-2 aperture:whitespace-nowrap">{chosen.length} selected</span>
          <Button
            size="sm"
            className="aperture:rounded-full"
            variant="outline"
            disabled={busy}
            onClick={() => suspend.mutate(chosen, clear)}
          >
            <Pause />
            Suspend
          </Button>
          <Button
            size="sm"
            className="aperture:rounded-full"
            variant="outline"
            disabled={busy}
            onClick={() => resume.mutate(chosen, clear)}
          >
            <Play />
            Resume
          </Button>
          <Button
            size="sm"
            className="aperture:rounded-full"
            variant="destructive"
            disabled={busy}
            onClick={() => setConfirming(chosen.length)}
          >
            <Trash2 />
            Delete
          </Button>
          <Button
            size="icon-sm"
            className="aperture:rounded-full"
            variant="ghost"
            aria-label="Clear selection"
            onClick={() => setSelected(new Set())}
          >
            <X />
          </Button>
        </div>
      ) : null}
      {sessions.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(sessions.error)}
        </p>
      ) : null}
      {sessions.data !== undefined && shown.length === 0 ? (
        <p
          data-console-empty
          className="aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
        >
          {sessions.data.length === 0 ? "No sessions yet." : "No session matches."}
        </p>
      ) : (
        <div className="aperture:grid aperture:grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] aperture:gap-4">
          {shown.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              selected={selected.has(session.id)}
              onSelect={(on, range) => select(session.id, on, range)}
            />
          ))}
        </div>
      )}
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
          remove.mutate(chosen, {
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
