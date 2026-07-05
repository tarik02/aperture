import { Link, createFileRoute } from "@tanstack/react-router";
import { AppWindow, MoreHorizontal, Plus, RotateCcw, Tags as TagsIcon, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { CreateSessionDialog } from "#/components/sessions/create-session-dialog.tsx";
import { PromoteSessionDialog } from "#/components/sessions/promote-session-dialog.tsx";
import {
  SessionDetailModals,
  type SessionDetailSection,
} from "#/components/sessions/session-detail-modals.tsx";
import type { TransientCdpCredentials } from "#/components/sessions/connection-panel.tsx";
import { BatchActionBar } from "#/components/resources/batch-action-bar.tsx";
import { EditTagsDialog } from "#/components/resources/edit-tags-dialog.tsx";
import {
  InfiniteTableShell,
  TableSkeletonRows,
} from "#/components/resources/infinite-table-shell.tsx";
import { SessionStatusBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { TagFilter } from "#/components/resources/tag-filter.tsx";
import { TenantRequiredNotice } from "#/components/resources/tenant-required.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  stickyTableEndCellClassName,
  stickyTableEndHeaderClassName,
  stickyTableStartCellClassName,
  stickyTableStartHeaderClassName,
} from "#/components/ui/table.tsx";
import {
  useDeleteSessionMutation,
  useReopenSessionMutation,
  useReplaceSessionTagsMutation,
  useRotateCdpTokenMutation,
} from "#/hooks/mutations/use-session-mutations.ts";
import { useSessionsInfiniteQuery } from "#/hooks/queries/use-sessions-query.ts";
import { hasAllScopes, hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import { formatTimestamp } from "#/lib/format.ts";
import type { TagFilterValue } from "#/lib/tag-filter.ts";
import type { CreateSessionResponse, Session } from "#/lib/api/schemas.ts";

export const Route = createFileRoute("/sessions/")({
  component: SessionsPage,
});

const ALL_STATUS = "__all__";

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: ALL_STATUS, label: "All" },
  { value: "running", label: "Running" },
  { value: "creating", label: "Creating" },
  { value: "deleted", label: "Deleted" },
  { value: "failed", label: "Failed" },
  { value: "expired", label: "Expired" },
];

const SESSION_SKELETON_COLUMNS = [
  {
    cellClassName: stickyTableStartCellClassName,
    skeletonClassName: "size-4 rounded-sm",
    sticky: "start",
  },
  { skeletonClassName: "h-4 w-72" },
  { skeletonClassName: "h-5 w-16 rounded-full" },
  { skeletonClassName: "h-4 w-16" },
  { skeletonClassName: "h-4 w-24" },
  { skeletonClassName: "h-5 w-40 rounded-full" },
  { skeletonClassName: "h-4 w-36" },
  {
    cellClassName: stickyTableEndCellClassName,
    skeletonClassName: "ml-auto size-7",
    sticky: "end",
  },
] as const;

function SessionsPage() {
  const credentials = useApiCredentials();
  const scopes = useActiveScopes();
  const canWrite = hasScope(scopes, "sessions:write");
  const canPromote = hasAllScopes(scopes, ["sessions:write", "snapshots:write"]);

  const [status, setStatus] = useState<string | undefined>();
  const [tags, setTags] = useState<TagFilterValue | undefined>();
  const includeDeleted = status === "deleted";

  const filters = useMemo(() => ({ includeDeleted, status, tags }), [includeDeleted, status, tags]);

  const query = useSessionsInfiniteQuery(filters);
  const loadedSessions = useMemo(
    () => flattenInfinitePages(query.data?.pages),
    [query.data?.pages],
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [promoteSession, setPromoteSession] = useState<Session | null>(null);
  const [tagsSession, setTagsSession] = useState<Session | null>(null);
  const [batchTagsOpen, setBatchTagsOpen] = useState(false);
  const [detailSession, setDetailSession] = useState<Session | null>(null);
  const [detailSection, setDetailSection] = useState<SessionDetailSection | null>(null);
  const [transientCdp, setTransientCdp] = useState<TransientCdpCredentials>(null);
  const [selectedSessions, setSelectedSessions] = useState<Record<string, Session>>({});
  const selectedSessionItems = useMemo(() => Object.values(selectedSessions), [selectedSessions]);
  const reopenableSessionItems = selectedSessionItems.filter(
    (session) => session.status !== "running",
  );

  const deleteMutation = useDeleteSessionMutation();
  const reopenMutation = useReopenSessionMutation();
  const rotateMutation = useRotateCdpTokenMutation();
  const replaceTagsMutation = useReplaceSessionTagsMutation();

  const tenantReady = isTenantScopedQueryReady(credentials);

  function openDetail(session: Session, section: SessionDetailSection = "details") {
    setTransientCdp(null);
    setDetailSession(session);
    setDetailSection(section);
  }

  function handleDetailSectionChange(section: SessionDetailSection | null) {
    setDetailSection(section);
    if (!section) {
      setTransientCdp(null);
    }
  }

  function handleCreated(result: CreateSessionResponse) {
    setTransientCdp({ cdpUrl: result.cdpUrl, cdpToken: result.cdpToken });
    setDetailSession(result.session);
    setDetailSection("connection");
  }

  function toggleSessionSelection(session: Session, selected: boolean) {
    setSelectedSessions((current) => {
      const next = { ...current };
      if (selected) {
        next[session.id] = session;
      } else {
        delete next[session.id];
      }
      return next;
    });
  }

  async function handleBatchDelete() {
    try {
      for (const session of selectedSessionItems) {
        await deleteMutation.mutateAsync(session.id);
      }
      setSelectedSessions({});
    } catch {
      return;
    }
  }

  async function handleBatchReopen() {
    try {
      for (const session of reopenableSessionItems) {
        await reopenMutation.mutateAsync(session.id);
      }
      setSelectedSessions({});
    } catch {
      return;
    }
  }

  async function handleReopen(session: Session) {
    const result = await reopenMutation.mutateAsync(session.id);
    if (result.cdpUrl && result.cdpToken) {
      setTransientCdp({ cdpUrl: result.cdpUrl, cdpToken: result.cdpToken });
      setDetailSession(session);
      setDetailSection("connection");
    }
  }

  async function handleRotate(session: Session) {
    const result = await rotateMutation.mutateAsync(session.id);
    if (result.cdpUrl && result.cdpToken) {
      setTransientCdp({ cdpUrl: result.cdpUrl, cdpToken: result.cdpToken });
      setDetailSession(session);
      setDetailSection("connection");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {canWrite && tenantReady ? (
        <PageHeaderActions>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus data-icon="inline-start" />
            Create
          </Button>
        </PageHeaderActions>
      ) : null}

      <div className="flex shrink-0 flex-col gap-3 p-3">
        <TenantRequiredNotice />
        {tenantReady ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              items={STATUS_OPTIONS}
              value={status ?? ALL_STATUS}
              onValueChange={(value) =>
                setStatus(value === ALL_STATUS ? undefined : (value ?? undefined))
              }
            >
              <SelectTrigger size="sm" className="w-32">
                <SelectValue placeholder="Status">
                  {(selectedValue: unknown) =>
                    STATUS_OPTIONS.find((option) => option.value === selectedValue)?.label ??
                    "Status"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.label} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <TagFilter
              value={tags}
              availableTags={loadedSessions.flatMap((session) =>
                session.tags ? [session.tags] : [],
              )}
              onChange={setTags}
            />
          </div>
        ) : null}
      </div>

      {tenantReady ? (
        <>
          <BatchActionBar
            selectedCount={selectedSessionItems.length}
            onClear={() => setSelectedSessions({})}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setBatchTagsOpen(true)}
              disabled={!canWrite || replaceTagsMutation.isPending}
            >
              <TagsIcon data-icon="inline-start" />
              Apply tags
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleBatchReopen()}
              disabled={
                !canWrite || reopenableSessionItems.length === 0 || reopenMutation.isPending
              }
            >
              <RotateCcw data-icon="inline-start" />
              Reopen
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void handleBatchDelete()}
              disabled={!canWrite || deleteMutation.isPending}
            >
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          </BatchActionBar>

          <InfiniteTableShell
            query={query}
            emptyTitle="No sessions"
            loading={
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      data-table-sticky="start"
                      className={stickyTableStartHeaderClassName}
                    />
                    <TableHead>ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Snapshot</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead data-table-sticky="end" className={stickyTableEndHeaderClassName} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableSkeletonRows columns={SESSION_SKELETON_COLUMNS} />
                </TableBody>
              </Table>
            }
          >
            {(items) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      data-table-sticky="start"
                      className={stickyTableStartHeaderClassName}
                    />
                    <TableHead>ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Snapshot</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead data-table-sticky="end" className={stickyTableEndHeaderClassName} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((session) => (
                    <TableRow
                      key={session.id}
                      data-state={selectedSessions[session.id] ? "selected" : undefined}
                      className="cursor-pointer"
                      onClick={() => openDetail(session)}
                    >
                      <TableCell
                        data-table-sticky="start"
                        className={stickyTableStartCellClassName}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Checkbox
                          aria-label={`Select session ${session.id}`}
                          checked={Boolean(selectedSessions[session.id])}
                          disabled={!canWrite}
                          onCheckedChange={(checked) => toggleSessionSelection(session, checked)}
                        />
                      </TableCell>
                      <TableCell className="break-all font-mono text-sm">{session.id}</TableCell>
                      <TableCell>
                        <SessionStatusBadge status={session.status} />
                      </TableCell>
                      <TableCell>{session.browserChannel ?? "—"}</TableCell>
                      <TableCell>{session.baseSnapshotName ?? "—"}</TableCell>
                      <TableCell>
                        <TagBadges tags={session.tags} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatTimestamp(session.createdAt)}
                      </TableCell>
                      <TableCell
                        data-table-sticky="end"
                        className={stickyTableEndCellClassName}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <SessionActionsMenu
                          session={session}
                          canWrite={canWrite}
                          canPromote={canPromote}
                          onDetails={() => openDetail(session, "details")}
                          onConnection={() => openDetail(session, "connection")}
                          onEvents={() => openDetail(session, "events")}
                          onDelete={() => void deleteMutation.mutateAsync(session.id)}
                          onReopen={() => void handleReopen(session)}
                          onPromote={() => setPromoteSession(session)}
                          onRotate={() => void handleRotate(session)}
                          onEditTags={() => setTagsSession(session)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </InfiniteTableShell>
        </>
      ) : null}

      <CreateSessionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />

      <PromoteSessionDialog
        session={promoteSession}
        open={promoteSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPromoteSession(null);
          }
        }}
      />

      <EditTagsDialog
        open={tagsSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTagsSession(null);
          }
        }}
        resourceKey={tagsSession ? `session:${tagsSession.id}` : null}
        title="Edit tags"
        initialTags={tagsSession?.tags}
        onSave={async (tags) => {
          if (!tagsSession) {
            return;
          }
          await replaceTagsMutation.mutateAsync({ sessionId: tagsSession.id, tags });
        }}
      />

      <EditTagsDialog
        open={batchTagsOpen}
        onOpenChange={setBatchTagsOpen}
        resourceKey={
          batchTagsOpen
            ? `sessions:batch:${selectedSessionItems.map((session) => session.id).join(",")}`
            : null
        }
        title="Apply tags"
        onSave={async (tags) => {
          for (const session of selectedSessionItems) {
            await replaceTagsMutation.mutateAsync({
              sessionId: session.id,
              tags: { ...session.tags, ...tags },
            });
          }
          setSelectedSessions({});
        }}
      />

      <SessionDetailModals
        session={detailSession}
        section={detailSection}
        onSectionChange={handleDetailSectionChange}
        transientCdp={transientCdp}
        onTransientCdpChange={setTransientCdp}
      />
    </div>
  );
}

type SessionActionsMenuProps = {
  session: Session;
  canWrite: boolean;
  canPromote: boolean;
  onDetails: () => void;
  onConnection: () => void;
  onEvents: () => void;
  onDelete: () => void;
  onReopen: () => void;
  onPromote: () => void;
  onRotate: () => void;
  onEditTags: () => void;
};

function SessionActionsMenu({
  session,
  canWrite,
  canPromote,
  onDetails,
  onConnection,
  onEvents,
  onDelete,
  onReopen,
  onPromote,
  onRotate,
  onEditTags,
}: SessionActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" />}
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem onClick={onDetails}>Details</DropdownMenuItem>
        <DropdownMenuItem onClick={onConnection}>Connection</DropdownMenuItem>
        <DropdownMenuItem onClick={onEvents}>Events</DropdownMenuItem>
        {canWrite ? (
          <>
            <DropdownMenuSeparator />
            {session.status === "running" ? (
              <DropdownMenuItem
                render={<Link to="/sessions/$sessionId" params={{ sessionId: session.id }} />}
              >
                <AppWindow />
                Open
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={onEditTags}>Edit tags</DropdownMenuItem>
            <DropdownMenuItem className="whitespace-nowrap" onClick={onRotate}>
              Rotate CDP token
            </DropdownMenuItem>
            {session.status !== "running" ? (
              <DropdownMenuItem onClick={onReopen}>Reopen</DropdownMenuItem>
            ) : null}
            {canPromote ? <DropdownMenuItem onClick={onPromote}>Promote</DropdownMenuItem> : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
