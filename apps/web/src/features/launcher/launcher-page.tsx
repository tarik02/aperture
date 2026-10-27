import { skipToken, useQueries } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AppWindow,
  ArrowLeft,
  Check,
  ChevronDown,
  Layers,
  ListFilter,
  Plus,
  PlugZap,
  SearchIcon,
} from "lucide-react";
import { useDeferredValue, useMemo, type ReactNode } from "react";
import {
  flattenInfinitePages,
  type BrowserStatus,
  type Session,
} from "@aperture-browser/api-client";
import { Badge } from "@aperture-browser/ui/components/badge";
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
import { SelectedTenantControl } from "#/components/selected-tenant-control.tsx";
import { useFailureNotice } from "#/hooks/use-failure-notice.ts";
import { usePageSearchShortcut } from "#/hooks/use-page-search-shortcut.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { useTenantApi } from "#/hooks/use-tenant-api.ts";
import { queryKeys } from "#/lib/api/query-keys.ts";
import { SessionCard } from "#/features/launcher/session-card.tsx";
import { SessionPickerMenu } from "#/features/launcher/session-picker-menu.tsx";
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
  const navigate = useNavigate();
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
  const activeSnapshotCount = snapshots.filter((snapshot) => !snapshot.deletedAt).length;

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
  const visibleSnapshots = snapshotNeedle
    ? snapshots.filter((snapshot) =>
        matchesSearch(snapshotNeedle, [snapshot.name, snapshot.description]),
      )
    : snapshots;

  const saveableSessions = useMemo(
    () => sessions.filter((session) => isSaveable(session.status)).sort(compareSaveable),
    [sessions],
  );

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

  const setView = (next: LauncherView) =>
    void navigate({ to: "/-/sessions", search: next === "snapshots" ? { view: next } : {} });

  const visibleSessionCount = visibleSessionIds === null ? sessions.length : visibleSessionIds.size;

  return (
    <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-col">
      <ScrollArea className="aperture:group/launcher aperture:min-h-0 aperture:flex-1">
        <div className="aperture:mx-auto aperture:grid aperture:w-full aperture:max-w-6xl aperture:gap-4 aperture:p-4">
          <div className="aperture:@container aperture:sticky aperture:top-0 aperture:z-10 aperture:-mx-4 aperture:-mt-4 aperture:-mb-2 aperture:border-b aperture:border-transparent aperture:bg-background aperture:px-4 aperture:pt-4 aperture:pb-2 aperture:group-data-[overflow-y-start]/launcher:border-border">
            {view === "sessions" ? (
              <div className="aperture:flex aperture:items-center aperture:gap-2">
                <SearchBox
                  inputRef={searchRef}
                  label="Search sessions"
                  value={sessionSearch}
                  onChange={setSessionSearch}
                />
                <StatusFilterMenu value={sessionStatus} onChange={setSessionStatus} />
                <ToolbarButton
                  variant="outline"
                  label="Connect an MCP client"
                  icon={<PlugZap />}
                  onClick={() => actions.connectMcp()}
                >
                  MCP
                </ToolbarButton>
                <ToolbarButton
                  variant="outline"
                  label="Snapshots"
                  icon={<Layers />}
                  onClick={() => setView("snapshots")}
                >
                  Snapshots
                  <Badge variant="secondary" className="aperture:@max-md:hidden">
                    {snapshotsQuery.hasNextPage ? `${activeSnapshotCount}+` : activeSnapshotCount}
                  </Badge>
                </ToolbarButton>
                {permissions.canWrite ? (
                  <ToolbarButton
                    label="New session"
                    icon={<Plus />}
                    onClick={() => actions.newSession()}
                  >
                    New session
                  </ToolbarButton>
                ) : null}
              </div>
            ) : (
              <div className="aperture:flex aperture:items-center aperture:gap-2">
                <ToolbarButton
                  variant="outline"
                  label="Sessions"
                  icon={<ArrowLeft />}
                  onClick={() => setView("sessions")}
                >
                  Sessions
                </ToolbarButton>
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
                    <DropdownMenuItem
                      onClick={() => setShowDeletedSnapshots(!showDeletedSnapshots)}
                    >
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
                        <span className="aperture:@max-md:sr-only">New snapshot</span>
                        <ChevronDown data-icon="inline-end" />
                      </Button>
                    }
                  />
                ) : null}
              </div>
            )}
          </div>

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
                  actionsPending={pending}
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
      {dialogs}
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
    <div className="aperture:relative aperture:min-w-0 aperture:flex-1">
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

function ToolbarButton({
  label,
  icon,
  variant = "default",
  onClick,
  children,
}: {
  label: string;
  icon: ReactNode;
  variant?: "default" | "outline";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant={variant} onClick={onClick} title={label} aria-label={label}>
      <span data-icon="inline-start" className="aperture:contents">
        {icon}
      </span>
      <span className="aperture:flex aperture:items-center aperture:gap-1.5 aperture:@max-md:sr-only">
        {children}
      </span>
    </Button>
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
