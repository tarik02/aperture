import { skipToken, useQueries } from "@tanstack/react-query";
import { AppWindow, Check, ChevronDown, Layers, ListFilter, Plus, SearchIcon } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, type ReactNode } from "react";
import { BatchActionBar } from "#/components/resources/batch-action-bar.tsx";
import {
  BulkActionButtons,
  SelectionContextMenu,
  type BulkAction,
} from "#/components/resources/selection-context-menu.tsx";
import type { ItemSelection } from "#/components/resources/selection-checkbox.tsx";
import { useRowSelection } from "#/hooks/use-row-selection.ts";
import {
  useSessionBulkActions,
  useSnapshotBulkActions,
} from "#/features/launcher/use-bulk-actions.tsx";
import {
  flattenInfinitePages,
  type BrowserStatus,
  type Session,
  type Snapshot,
} from "@aperture-browser/api-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aperture-browser/ui/components/empty";
import { Input } from "@aperture-browser/ui/components/input";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { cn } from "@aperture-browser/ui/utils";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SelectedTenantControl } from "#/components/selected-tenant-control.tsx";
import { useFailureNotice } from "#/hooks/use-failure-notice.ts";
import { usePageSearchShortcut } from "#/hooks/use-page-search-shortcut.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { useTenantApi } from "#/hooks/use-tenant-api.ts";
import { queryKeys } from "#/lib/api/query-keys.ts";
import { SessionCard } from "#/features/launcher/session-card.tsx";
import { SessionPickerMenu } from "#/features/launcher/session-picker-menu.tsx";
import { NewSessionButton } from "#/features/session/new-session-button.tsx";
import { SnapshotRow } from "#/features/launcher/snapshot-row.tsx";
import { useLauncherStore, type SessionStatusFilter } from "#/features/launcher/launcher.store.ts";
import { useOpenSessions } from "#/features/session/open-sessions.ts";
import { useSessionDialogs } from "#/features/session/session-dialogs.tsx";
import {
  compareSaveable,
  isExpired,
  isSaveable,
  matchesSearch,
  sessionTitle,
} from "#/features/session/session-display.ts";
import { useSessionsInfiniteQuery } from "#/features/session/session.queries.ts";
import { useSnapshotsInfiniteQuery } from "#/features/snapshot/snapshot.queries.ts";

export type LauncherView = "sessions" | "snapshots";

const statusFilters: Array<{ value: SessionStatusFilter; label: string }> = [
  { value: "active", label: "Active" },
  { value: "failed", label: "Failed" },
  { value: "deleted", label: "Deleted" },
];

export function LauncherPage({ view }: { view: LauncherView }) {
  const api = useTenantApi();
  const scopes = useActiveScopes();
  const canWriteSnapshots = hasScope(scopes, "snapshots:write");
  const { actions, dialogs, permissions, pending } = useSessionDialogs();
  const openSessions = useOpenSessions();
  const searchRef = usePageSearchShortcut(api.ready);

  const sessionSearch = useLauncherStore((state) => state.sessionSearch);
  const snapshotSearch = useLauncherStore((state) => state.snapshotSearch);
  const sessionStatus = useLauncherStore((state) => state.sessionStatus);
  const showDeletedSnapshots = useLauncherStore((state) => state.showDeletedSnapshots);
  const setSessionSearch = useLauncherStore((state) => state.setSessionSearch);
  const setSnapshotSearch = useLauncherStore((state) => state.setSnapshotSearch);
  const setSessionStatus = useLauncherStore((state) => state.setSessionStatus);
  const setShowDeletedSnapshots = useLauncherStore((state) => state.setShowDeletedSnapshots);

  const sessionsQuery = useSessionsInfiniteQuery(
    {
      limit: 100,
      status: sessionStatus === "active" ? undefined : sessionStatus,
      includeDeleted: sessionStatus === "deleted",
    },
    { poll: true },
  );
  const snapshotsQuery = useSnapshotsInfiniteQuery({
    limit: 100,
    deleted: showDeletedSnapshots ? "all" : "active",
  });
  useFailureNotice("sessions-list", "Sessions", sessionsQuery.error);
  useFailureNotice("snapshots-list", "Snapshots", snapshotsQuery.error);

  const sessions = useMemo(() => {
    const now = Date.now();
    return flattenInfinitePages(sessionsQuery.data?.pages)
      .filter((session) => sessionStatus !== "active" || !isExpired(session, now))
      .filter((session) => sessionStatus !== "active" || session.status !== "deleted")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [sessionsQuery.data?.pages, sessionStatus]);
  const snapshots = useMemo(
    () => flattenInfinitePages(snapshotsQuery.data?.pages),
    [snapshotsQuery.data?.pages],
  );

  // Page lists load inside the cards; reading them from the cache makes page titles and URLs
  // searchable without fetching anything here.
  const statuses = useQueries({
    queries: sessions.map((session) => ({
      queryKey: queryKeys.browserStatus(api.tenantKey, session.id, session.status),
      queryFn: skipToken,
    })),
  });
  const pagesById = useMemo(() => {
    const map = new Map<string, BrowserStatus["pages"]>();
    sessions.forEach((session, index) => {
      const data = statuses[index]?.data as BrowserStatus | undefined;
      if (data) {
        map.set(session.id, data.pages);
      }
    });
    return map;
  }, [sessions, statuses]);
  const titleOf = (session: Session) => sessionTitle(session, pagesById.get(session.id));

  const sessionNeedle = useDeferredValue(sessionSearch.trim().toLowerCase());
  const visibleSessionIds = useMemo(() => {
    if (!sessionNeedle) {
      return null;
    }
    return new Set(
      sessions
        .filter((session) =>
          matchesSearch(sessionNeedle, [
            session.label,
            session.baseSnapshotName,
            session.id,
            ...(pagesById.get(session.id) ?? []).flatMap((page) => [page.title, page.url]),
          ]),
        )
        .map((session) => session.id),
    );
  }, [pagesById, sessionNeedle, sessions]);

  const snapshotNeedle = useDeferredValue(snapshotSearch.trim().toLowerCase());
  const visibleSnapshots = useMemo(
    () =>
      snapshotNeedle
        ? snapshots.filter((snapshot) =>
            matchesSearch(snapshotNeedle, [snapshot.name, snapshot.description]),
          )
        : snapshots,
    [snapshotNeedle, snapshots],
  );

  const saveableSessions = useMemo(
    () => sessions.filter((session) => isSaveable(session.status)).sort(compareSaveable),
    [sessions],
  );

  const visibleSessions = useMemo(
    () =>
      visibleSessionIds === null
        ? sessions
        : sessions.filter((session) => visibleSessionIds.has(session.id)),
    [sessions, visibleSessionIds],
  );
  const sessionSelection = useRowSelection({
    tableKey: "launcher-sessions",
    rows: visibleSessions,
    getId: getItemId,
  });
  const snapshotSelection = useRowSelection({
    tableKey: "launcher-snapshots",
    rows: visibleSnapshots,
    getId: getItemId,
  });
  const sessionBulk = useSessionBulkActions(sessionSelection.selectedItems, sessionSelection.clear);
  const snapshotBulk = useSnapshotBulkActions(
    snapshotSelection.selectedItems,
    snapshotSelection.clear,
  );
  const current =
    view === "sessions"
      ? { selection: sessionSelection, bulk: sessionBulk }
      : { selection: snapshotSelection, bulk: snapshotBulk };

  // Another status filter shows other sessions; a selection the list no longer shows would
  // still be acted on.
  const clearSessionSelection = sessionSelection.clear;
  useEffect(() => clearSessionSelection(), [clearSessionSelection, sessionStatus]);

  const clearCurrent = current.selection.clear;
  const hasSelection = current.selection.selectedCount > 0;
  useEffect(() => {
    if (!hasSelection) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        document.querySelector("[role=dialog]") === null
      ) {
        clearCurrent();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearCurrent, hasSelection]);

  if (!api.ready) {
    return (
      <div className="aperture:flex aperture:h-full aperture:items-center aperture:justify-center aperture:p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AppWindow />
            </EmptyMedia>
            <EmptyTitle>Select a tenant</EmptyTitle>
            <EmptyDescription>Sessions and snapshots belong to a tenant.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <SelectedTenantControl />
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const visibleSessionCount = visibleSessionIds === null ? sessions.length : visibleSessionIds.size;

  return (
    <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-col">
      <PageHeaderActions>
        {view === "sessions" ? (
          <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:justify-end aperture:gap-2">
            <SearchBox
              inputRef={searchRef}
              label="Search sessions"
              value={sessionSearch}
              onChange={setSessionSearch}
            />
            <StatusFilterMenu value={sessionStatus} onChange={setSessionStatus} />
            {permissions.canWrite ? (
              <NewSessionButton onCustom={(request) => actions.newSession(request)} />
            ) : null}
          </div>
        ) : (
          <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:justify-end aperture:gap-2">
            <SearchBox
              inputRef={searchRef}
              label="Search snapshots"
              value={snapshotSearch}
              onChange={setSnapshotSearch}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant={showDeletedSnapshots ? "secondary" : "ghost"}
                    size="icon"
                    aria-label="Filter snapshots"
                    title="Filter snapshots"
                  >
                    <ListFilter />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="aperture:min-w-44">
                <DropdownMenuItem onClick={() => setShowDeletedSnapshots(!showDeletedSnapshots)}>
                  <Check className={cn(!showDeletedSnapshots && "aperture:invisible")} />
                  Show deleted
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {permissions.canSaveSnapshots ? (
              <SessionPickerMenu
                sessions={saveableSessions}
                titleOf={titleOf}
                onPick={(session) => actions.saveToSnapshot(session)}
                trigger={
                  <Button title="New snapshot" aria-label="New snapshot">
                    <Plus data-icon="inline-start" />
                    <span className="aperture:max-md:sr-only">New snapshot</span>
                    <ChevronDown data-icon="inline-end" />
                  </Button>
                }
              />
            ) : null}
          </div>
        )}
      </PageHeaderActions>
      <ScrollArea className="aperture:min-h-0 aperture:flex-1">
        <div
          className={cn(
            "aperture:mx-auto aperture:grid aperture:w-full aperture:max-w-6xl aperture:gap-4 aperture:p-4",
            // Room for the floating selection bar, so it never covers the last item.
            hasSelection && "aperture:pb-20",
          )}
        >
          {view === "sessions" ? (
            <>
              {sessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  // Filtered-out cards stay mounted so their page lists keep loading for search.
                  hidden={visibleSessionIds !== null && !visibleSessionIds.has(session.id)}
                  openInfo={openSessions.get(session.id)}
                  actions={actions}
                  permissions={permissions}
                  actionsPending={pending || sessionBulk.pending}
                  selection={
                    permissions.canWrite ? itemSelection(sessionSelection, session.id) : undefined
                  }
                  wrap={selectionMenu(sessionSelection, session.id, sessionBulk.actions)}
                />
              ))}
              {sessionsQuery.isPending ? (
                <CenteredNote>
                  <Spinner />
                </CenteredNote>
              ) : visibleSessionCount === 0 ? (
                <CenteredNote>
                  {sessionNeedle
                    ? "No sessions match."
                    : sessionStatus === "active"
                      ? "No browser sessions yet."
                      : `No ${sessionStatus} sessions.`}
                </CenteredNote>
              ) : null}
              <LoadMore
                visible={sessionsQuery.hasNextPage}
                pending={sessionsQuery.isFetchingNextPage}
                onClick={() => void sessionsQuery.fetchNextPage()}
              />
            </>
          ) : (
            <>
              {visibleSnapshots.map((snapshot) => (
                <SnapshotRow
                  key={snapshot.id}
                  snapshot={snapshot}
                  saveableSessions={saveableSessions}
                  titleOf={titleOf}
                  actions={actions}
                  permissions={permissions}
                  canWriteSnapshots={canWriteSnapshots}
                  selection={
                    canWriteSnapshots ? itemSelection(snapshotSelection, snapshot.id) : undefined
                  }
                  wrap={selectionMenu(snapshotSelection, snapshot.id, snapshotBulk.actions)}
                />
              ))}
              {snapshotsQuery.isPending ? (
                <CenteredNote>
                  <Spinner />
                </CenteredNote>
              ) : snapshots.length === 0 ? (
                <div className="aperture:grid aperture:justify-items-center aperture:gap-2 aperture:rounded-xl aperture:border aperture:border-dashed aperture:p-8 aperture:text-center">
                  <Layers className="aperture:size-6 aperture:text-muted-foreground" />
                  <p className="aperture:text-sm aperture:font-medium">No snapshots yet</p>
                  <p className="aperture:max-w-md aperture:text-sm aperture:text-muted-foreground">
                    A snapshot is a saved copy of a browser session's logins and browser state that
                    new sessions can start from. Use "New snapshot" above, or "Save to snapshot" in
                    a session's menu.
                  </p>
                </div>
              ) : visibleSnapshots.length === 0 ? (
                <CenteredNote>No snapshots match.</CenteredNote>
              ) : null}
              <LoadMore
                visible={snapshotsQuery.hasNextPage}
                pending={snapshotsQuery.isFetchingNextPage}
                onClick={() => void snapshotsQuery.fetchNextPage()}
              />
            </>
          )}
        </div>
      </ScrollArea>
      <BatchActionBar
        selectedCount={current.selection.selectedCount}
        onClear={current.selection.clear}
      >
        <BulkActionButtons actions={current.bulk.actions} />
      </BatchActionBar>
      {dialogs}
      {sessionBulk.dialog}
      {snapshotBulk.dialog}
    </div>
  );
}

function SearchBox({
  inputRef,
  label,
  value,
  onChange,
}: {
  inputRef: React.Ref<HTMLInputElement>;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="aperture:relative aperture:min-w-0 aperture:max-w-md aperture:flex-1">
      <SearchIcon className="aperture:pointer-events-none aperture:absolute aperture:top-1/2 aperture:left-2.5 aperture:size-4 aperture:-translate-y-1/2 aperture:text-muted-foreground" />
      <Input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        aria-label={label}
        className="aperture:pl-8"
      />
    </div>
  );
}

function StatusFilterMenu({
  value,
  onChange,
}: {
  value: SessionStatusFilter;
  onChange: (value: SessionStatusFilter) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={value === "active" ? "ghost" : "secondary"}
            size="icon"
            aria-label="Filter sessions by status"
            title="Filter sessions by status"
          >
            <ListFilter />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="aperture:min-w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show</DropdownMenuLabel>
          {statusFilters.map((filter) => (
            <DropdownMenuItem key={filter.value} onClick={() => onChange(filter.value)}>
              <Check className={cn(value !== filter.value && "aperture:invisible")} />
              {filter.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CenteredNote({ children }: { children: ReactNode }) {
  return (
    <div className="aperture:flex aperture:justify-center aperture:py-10 aperture:text-sm aperture:text-muted-foreground">
      {children}
    </div>
  );
}

function LoadMore({
  visible,
  pending,
  onClick,
}: {
  visible: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  if (!visible) {
    return null;
  }
  return (
    <div className="aperture:flex aperture:justify-center">
      <Button variant="ghost" size="sm" onClick={onClick} disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        Load more
      </Button>
    </div>
  );
}

const getItemId = (item: Session | Snapshot) => item.id;

type Selection =
  | ReturnType<typeof useRowSelection<Session>>
  | ReturnType<typeof useRowSelection<Snapshot>>;

function itemSelection(selection: Selection, id: string): ItemSelection {
  return {
    selected: selection.isSelected(id),
    active: selection.selectedCount > 0,
    onChange: (checked, shiftKey) => selection.toggleOne(id, checked, shiftKey),
  };
}

/** Right-clicking a selected item opens the actions for the whole selection. */
function selectionMenu(selection: Selection, id: string, actions: readonly BulkAction[]) {
  if (!selection.isSelected(id)) {
    return undefined;
  }
  return (item: React.ReactElement) => (
    <SelectionContextMenu itemCount={selection.selectedCount} actions={actions} trigger={item} />
  );
}
