import { Link } from "@tanstack/react-router";
import {
  AppWindow,
  MoreHorizontal,
  Pause,
  Plus,
  RotateCcw,
  Tags as TagsIcon,
  Trash2,
} from "lucide-react";
import { useMemo } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SessionCreateModal } from "#/features/session/create-modal/session-create-modal.tsx";
import { SessionPromoteModal } from "#/features/session/promote-modal/session-promote-modal.tsx";
import { SessionDetailModals } from "#/components/sessions/session-detail-modals.tsx";
import { BatchActionBar } from "#/components/resources/batch-action-bar.tsx";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { TagEditModal } from "#/features/tag/edit-modal/tag-edit-modal.tsx";
import { tagsToEntries } from "#/components/resources/tag-editor.tsx";
import { SelectedTenantControl } from "#/components/selected-tenant-control.tsx";
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  useSuspendSessionMutation,
} from "#/features/session/session.mutations.ts";
import { useSessionsInfiniteQuery } from "#/features/session/session.queries.ts";
import { hasAllScopes, hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import { formatTimestamp } from "#/lib/format.ts";
import type { Session } from "#/lib/api/schemas.ts";
import { cn } from "#/lib/utils.ts";
import { useSessionListPageStore } from "#/features/session/list-page/session-list-page.store.ts";
import { useSessionCreateModalStore } from "#/features/session/create-modal/session-create-modal.store.ts";
import { useSessionFormStore } from "#/features/session/form/session-form.store.ts";
import { useSessionPromoteFormStore } from "#/features/session/promote-form/session-promote-form.store.ts";
import { useSessionPromoteModalStore } from "#/features/session/promote-modal/session-promote-modal.store.ts";
import { useTagEditModalStore } from "#/features/tag/edit-modal/tag-edit-modal.store.ts";
import { useTagFormStore } from "#/features/tag/form/tag-form.store.ts";

const ALL_STATUS = "__all__";

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: ALL_STATUS, label: "All" },
  { value: "running", label: "Running" },
  { value: "suspended", label: "Suspended" },
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
  { skeletonClassName: "h-8 w-72" },
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

type ConfirmDialogContent = {
  title: string;
  description: string;
  confirmLabel: string;
  variant: "default" | "destructive";
  pending: boolean;
};

export function SessionListPage() {
  const credentials = useApiCredentials();
  const scopes = useActiveScopes();
  const canWrite = hasScope(scopes, "sessions:write");
  const canPromote = hasAllScopes(scopes, ["sessions:write", "snapshots:write"]);

  const status = useSessionListPageStore((state) => state.status);
  const tags = useSessionListPageStore((state) => state.tags);
  const setStatus = useSessionListPageStore((state) => state.setStatus);
  const setTags = useSessionListPageStore((state) => state.setTags);
  const includeDeleted = status === "deleted";

  const filters = useMemo(() => ({ includeDeleted, status, tags }), [includeDeleted, status, tags]);

  const query = useSessionsInfiniteQuery(filters);
  const loadedSessions = useMemo(
    () => flattenInfinitePages(query.data?.pages),
    [query.data?.pages],
  );

  const initCreateSessionForm = useSessionFormStore((state) => state.initForm);
  const openCreateSessionModal = useSessionCreateModalStore((state) => state.openModal);
  const initPromoteSessionForm = useSessionPromoteFormStore((state) => state.initForm);
  const openPromoteSessionModal = useSessionPromoteModalStore((state) => state.openModal);
  const initTagForm = useTagFormStore((state) => state.initForm);
  const tagResourceKey = useTagFormStore((state) => state.formData.resourceKey);
  const tagModalOpen = useTagEditModalStore((state) => state.open);
  const openTagModal = useTagEditModalStore((state) => state.openModal);
  const detailSession = useSessionListPageStore((state) => state.detailSession);
  const detailSection = useSessionListPageStore((state) => state.detailSection);
  const selectedSessions = useSessionListPageStore((state) => state.selectedSessions);
  const confirmAction = useSessionListPageStore((state) => state.confirmAction);
  const openDetail = useSessionListPageStore((state) => state.openDetail);
  const setDetailSession = useSessionListPageStore((state) => state.setDetailSession);
  const setDetailSection = useSessionListPageStore((state) => state.setDetailSection);
  const openCreatedSession = useSessionListPageStore((state) => state.openCreatedSession);
  const openConnection = useSessionListPageStore((state) => state.openConnection);
  const toggleSessionSelection = useSessionListPageStore((state) => state.toggleSessionSelection);
  const clearSelectedSessions = useSessionListPageStore((state) => state.clearSelectedSessions);
  const removeSelectedSession = useSessionListPageStore((state) => state.removeSelectedSession);
  const setConfirmAction = useSessionListPageStore((state) => state.setConfirmAction);
  const selectedSessionItems = useMemo(() => Object.values(selectedSessions), [selectedSessions]);
  const runningSessionItems = selectedSessionItems.filter(
    (session) => session.status === "running",
  );
  const reopenableSessionItems = selectedSessionItems.filter(
    (session) => session.status === "deleted" || session.status === "failed",
  );
  const tagsSession =
    tagModalOpen && tagResourceKey?.startsWith("session:") === true
      ? (loadedSessions.find((session) => `session:${session.id}` === tagResourceKey) ?? null)
      : null;
  const batchTagsResourceKey =
    tagModalOpen && tagResourceKey?.startsWith("sessions:batch:") === true ? tagResourceKey : null;

  const deleteMutation = useDeleteSessionMutation();
  const reopenMutation = useReopenSessionMutation();
  const suspendMutation = useSuspendSessionMutation();
  const rotateMutation = useRotateCdpTokenMutation();
  const replaceTagsMutation = useReplaceSessionTagsMutation();

  const tenantReady = isTenantScopedQueryReady(credentials);

  async function handleBatchDelete() {
    try {
      for (const session of selectedSessionItems) {
        await deleteMutation.mutateAsync(session.id);
      }
      clearSelectedSessions();
    } catch {
      return;
    }
  }

  async function handleBatchReopen() {
    try {
      for (const session of reopenableSessionItems) {
        await reopenMutation.mutateAsync(session.id);
      }
      clearSelectedSessions();
    } catch {
      return;
    }
  }

  async function handleBatchSuspend() {
    try {
      for (const session of runningSessionItems) {
        await suspendMutation.mutateAsync(session.id);
      }
      clearSelectedSessions();
    } catch {
      return;
    }
  }

  async function handleReopen(session: Session) {
    const result = await reopenMutation.mutateAsync(session.id);
    openConnection(result.session);
  }

  async function handleSuspend(session: Session) {
    await suspendMutation.mutateAsync(session.id);
  }

  async function handleRotate(session: Session) {
    const result = await rotateMutation.mutateAsync(session.id);
    openConnection(result.session);
  }

  async function handleConfirmAction() {
    const action = confirmAction;
    if (!action) {
      return;
    }

    switch (action.kind) {
      case "batch-delete":
        await handleBatchDelete();
        return;
      case "batch-suspend":
        await handleBatchSuspend();
        return;
      case "delete":
        await deleteMutation.mutateAsync(action.session.id);
        removeSelectedSession(action.session.id);
        return;
      case "suspend":
        await handleSuspend(action.session);
        return;
      case "rotate":
        await handleRotate(action.session);
        return;
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  const confirmDialog: ConfirmDialogContent | null =
    confirmAction?.kind === "batch-delete"
      ? {
          title: "Delete sessions",
          description: `Delete ${selectedSessionItems.length} selected session${selectedSessionItems.length === 1 ? "" : "s"}?`,
          confirmLabel: "Delete",
          variant: "destructive",
          pending: deleteMutation.isPending,
        }
      : confirmAction?.kind === "batch-suspend"
        ? {
            title: "Suspend sessions",
            description: `Suspend ${runningSessionItems.length} running session${runningSessionItems.length === 1 ? "" : "s"}?`,
            confirmLabel: "Suspend",
            variant: "default",
            pending: suspendMutation.isPending,
          }
        : confirmAction?.kind === "delete"
          ? {
              title: "Delete session",
              description: `Delete session ${confirmAction.session.id}?`,
              confirmLabel: "Delete",
              variant: "destructive",
              pending: deleteMutation.isPending,
            }
          : confirmAction?.kind === "suspend"
            ? {
                title: "Suspend session",
                description: `Suspend session ${confirmAction.session.id}?`,
                confirmLabel: "Suspend",
                variant: "default",
                pending: suspendMutation.isPending,
              }
            : confirmAction?.kind === "rotate"
              ? {
                  title: "Rotate CDP token",
                  description: "The current CDP token for this session will stop working.",
                  confirmLabel: "Rotate",
                  variant: "default",
                  pending: rotateMutation.isPending,
                }
              : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {canWrite && tenantReady ? (
        <PageHeaderActions>
          <Button
            size="sm"
            onClick={() => {
              initCreateSessionForm();
              openCreateSessionModal();
            }}
          >
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
            onClear={clearSelectedSessions}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                initTagForm(
                  "apply",
                  `sessions:batch:${selectedSessionItems.map((session) => session.id).join(",")}`,
                  [],
                );
                openTagModal();
              }}
              disabled={!canWrite || replaceTagsMutation.isPending}
            >
              <TagsIcon data-icon="inline-start" />
              Apply tags
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmAction({ kind: "batch-suspend" })}
              disabled={!canWrite || runningSessionItems.length === 0 || suspendMutation.isPending}
            >
              <Pause data-icon="inline-start" />
              Suspend
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
              onClick={() => setConfirmAction({ kind: "batch-delete" })}
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
                    <TableHead>Session</TableHead>
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
                    <TableHead>Session</TableHead>
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
                        className={`${stickyTableStartCellClassName} ${canWrite ? "cursor-pointer" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (canWrite) {
                            toggleSessionSelection(session, !selectedSessions[session.id]);
                          }
                        }}
                      >
                        <Checkbox
                          aria-label={`Select session ${session.id}`}
                          checked={Boolean(selectedSessions[session.id])}
                          disabled={!canWrite}
                          onClick={(event) => event.stopPropagation()}
                          onCheckedChange={(checked) => toggleSessionSelection(session, checked)}
                        />
                      </TableCell>
                      <TableCell className="min-w-72">
                        {session.label ? (
                          <div className="max-w-96 truncate font-medium">{session.label}</div>
                        ) : null}
                        <div
                          className={cn(
                            "break-all font-mono leading-snug",
                            session.label ? "text-xs text-muted-foreground" : "text-sm",
                          )}
                        >
                          {session.id}
                        </div>
                      </TableCell>
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
                          onDelete={() => setConfirmAction({ kind: "delete", session })}
                          onReopen={() => void handleReopen(session)}
                          onSuspend={() => setConfirmAction({ kind: "suspend", session })}
                          onPromote={() => {
                            initPromoteSessionForm(session.id);
                            openPromoteSessionModal();
                          }}
                          onRotate={() => setConfirmAction({ kind: "rotate", session })}
                          onEditTags={() => {
                            initTagForm(
                              "edit",
                              `session:${session.id}`,
                              tagsToEntries(session.tags ?? {}),
                            );
                            openTagModal();
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </InfiniteTableShell>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 p-3 pt-0">
          <Empty className="min-h-full border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AppWindow />
              </EmptyMedia>
              <EmptyTitle>Select tenant</EmptyTitle>
              <EmptyDescription>Select a tenant to view sessions.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <SelectedTenantControl />
            </EmptyContent>
          </Empty>
        </div>
      )}

      <SessionCreateModal onCreated={openCreatedSession} />

      <SessionPromoteModal />

      <TagEditModal
        resourceKey={tagsSession ? `session:${tagsSession.id}` : null}
        title="Edit tags"
        onSave={async (tags) => {
          if (!tagsSession) {
            return;
          }
          await replaceTagsMutation.mutateAsync({ sessionId: tagsSession.id, tags });
        }}
      />

      <TagEditModal
        resourceKey={batchTagsResourceKey}
        title="Apply tags"
        onSave={async (tags) => {
          for (const session of selectedSessionItems) {
            await replaceTagsMutation.mutateAsync({
              sessionId: session.id,
              tags: { ...session.tags, ...tags },
            });
          }
          clearSelectedSessions();
        }}
      />

      <SessionDetailModals
        session={detailSession}
        section={detailSection}
        onSectionChange={setDetailSection}
        onSessionChange={setDetailSession}
        actions={{
          canWrite,
          canPromote,
          deletePending: deleteMutation.isPending,
          reopenPending: reopenMutation.isPending,
          suspendPending: suspendMutation.isPending,
          rotatePending: rotateMutation.isPending,
          onDelete: (session) => setConfirmAction({ kind: "delete", session }),
          onEditTags: (session) => {
            initTagForm("edit", `session:${session.id}`, tagsToEntries(session.tags ?? {}));
            openTagModal();
          },
          onPromote: (session) => {
            initPromoteSessionForm(session.id);
            openPromoteSessionModal();
          },
          onReopen: (session) => void handleReopen(session),
          onSuspend: (session) => setConfirmAction({ kind: "suspend", session }),
          onRotate: (session) => setConfirmAction({ kind: "rotate", session }),
        }}
      />

      {confirmDialog ? (
        <ConfirmDialog
          open={confirmAction !== null}
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmLabel={confirmDialog.confirmLabel}
          variant={confirmDialog.variant}
          pending={confirmDialog.pending}
          onOpenChange={(open) => {
            if (!open) {
              setConfirmAction(null);
            }
          }}
          onConfirm={handleConfirmAction}
        />
      ) : null}
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
  onSuspend: () => void;
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
  onSuspend,
  onPromote,
  onRotate,
  onEditTags,
}: SessionActionsMenuProps) {
  const sessionPromotable =
    session.status === "suspended" || session.status === "deleted" || session.status === "failed";

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
            {session.status === "running" || session.status === "suspended" ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <AppWindow />
                  Open
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem
                    render={<Link to="/-/sessions/$sessionId" params={{ sessionId: session.id }} />}
                  >
                    Default
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    render={
                      <Link
                        to="/-/sessions/$sessionId"
                        params={{ sessionId: session.id }}
                        search={{ media: "cdp" }}
                      />
                    }
                  >
                    CDP fallback
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            <DropdownMenuItem onClick={onEditTags}>Edit tags</DropdownMenuItem>
            <DropdownMenuItem className="whitespace-nowrap" onClick={onRotate}>
              Rotate CDP token
            </DropdownMenuItem>
            {session.status === "deleted" || session.status === "failed" ? (
              <DropdownMenuItem onClick={onReopen}>Reopen</DropdownMenuItem>
            ) : null}
            {session.status === "running" ? (
              <DropdownMenuItem onClick={onSuspend}>
                <Pause />
                Suspend
              </DropdownMenuItem>
            ) : null}
            {canPromote && sessionPromotable ? (
              <DropdownMenuItem onClick={onPromote}>Promote</DropdownMenuItem>
            ) : null}
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
