import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@aperture-browser/ui/components/native-select";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Pause, Play, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SessionCreateDialog } from "#/features/session/session-create-dialog.tsx";
import { SessionCard } from "#/features/session/session-card.tsx";
import {
  useBulkSessionActionMutation,
  useCreateSessionMutation,
} from "#/features/session/session.mutations.ts";
import { type Session, useSessionsQuery } from "#/features/session/session.queries.ts";
import { useSelectedWorkspace } from "#/features/workspace/workspace.queries.ts";
import { told } from "#/lib/api.ts";

type Status = "all" | "active" | "suspended" | "failed";
type Order = "created" | "label";

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
  const create = useCreateSessionMutation();
  const suspend = useBulkSessionActionMutation("suspend");
  const resume = useBulkSessionActionMutation("resume");
  const remove = useBulkSessionActionMutation("delete");
  const navigate = useNavigate();
  const workspace = useSelectedWorkspace();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [order, setOrder] = useState<Order>("created");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
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

  const createAndOpen = () =>
    create.mutate(workspace === null ? {} : { workspaceId: workspace.id }, {
      onSuccess: (session) =>
        navigate({ to: "/-/sessions/$sessionId", params: { sessionId: session.id } }),
    });

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
        <NativeSelect
          size="sm"
          aria-label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value as Status)}
        >
          <NativeSelectOption value="all">All</NativeSelectOption>
          <NativeSelectOption value="active">Active</NativeSelectOption>
          <NativeSelectOption value="suspended">Suspended</NativeSelectOption>
          <NativeSelectOption value="failed">Failed</NativeSelectOption>
        </NativeSelect>
        <NativeSelect
          size="sm"
          aria-label="Sort"
          value={order}
          onChange={(event) => setOrder(event.target.value as Order)}
        >
          <NativeSelectOption value="created">Newest</NativeSelectOption>
          <NativeSelectOption value="label">Label</NativeSelectOption>
        </NativeSelect>
        <div className="aperture:flex">
          <Button
            data-console-create
            size="sm"
            className="aperture:rounded-r-none"
            disabled={create.isPending}
            onClick={createAndOpen}
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
          className="aperture:flex aperture:items-center aperture:gap-2 aperture:rounded-lg aperture:border aperture:bg-muted/50 aperture:px-3 aperture:py-1.5 aperture:text-sm"
        >
          <span className="aperture:flex-1">{chosen.length} selected</span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => suspend.mutate(chosen, clear)}
          >
            <Pause />
            Suspend
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => resume.mutate(chosen, clear)}
          >
            <Play />
            Resume
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
            Delete
          </Button>
          <Button
            size="icon-sm"
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
        open={confirming}
        title={`Delete ${chosen.length} sessions?`}
        description="Their profiles and files are removed. Snapshots taken of them stay."
        confirmLabel="Delete"
        variant="destructive"
        pending={remove.isPending}
        onOpenChange={setConfirming}
        onConfirm={() =>
          remove.mutate(chosen, {
            onSettled: () => {
              setConfirming(false);
              setSelected(new Set());
            },
          })
        }
      />
    </div>
  );
}
