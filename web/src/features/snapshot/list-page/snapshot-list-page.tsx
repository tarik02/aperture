import { useNavigate } from "@tanstack/react-router";
import { AppWindow, MoreHorizontal, RotateCcw, Tags as TagsIcon, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { SnapshotDetailModals } from "#/components/snapshots/snapshot-detail-modals.tsx";
import { BatchActionBar } from "#/components/resources/batch-action-bar.tsx";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { SessionCreateModal } from "#/features/session/create-modal/session-create-modal.tsx";
import { TagEditModal } from "#/features/tag/edit-modal/tag-edit-modal.tsx";
import { tagsToEntries } from "#/components/resources/tag-editor.tsx";
import { DeletedStatusSelect } from "#/components/resources/deleted-status-select.tsx";
import {
  InfiniteTableShell,
  TableSkeletonRows,
} from "#/components/resources/infinite-table-shell.tsx";
import { DeletedBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { TagFilter } from "#/components/resources/tag-filter.tsx";
import { TenantRequiredNotice } from "#/components/resources/tenant-required.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
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
  useDeleteSnapshotMutation,
  useReplaceSnapshotTagsMutation,
  useRestoreSnapshotMutation,
  useUpdateSnapshotMutation,
} from "#/features/snapshot/snapshot.mutations.ts";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { useSnapshotsInfiniteQuery } from "#/features/snapshot/snapshot.queries.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import { formatTimestamp } from "#/lib/format.ts";
import type { CreateSessionResponse, Snapshot } from "#/lib/api/schemas.ts";
import { useSessionCreateModalStore } from "#/features/session/create-modal/session-create-modal.store.ts";
import { useSessionFormStore } from "#/features/session/form/session-form.store.ts";
import { useSessionListPageStore } from "#/features/session/list-page/session-list-page.store.ts";
import { useSnapshotListPageStore } from "#/features/snapshot/list-page/snapshot-list-page.store.ts";
import { useTagEditModalStore } from "#/features/tag/edit-modal/tag-edit-modal.store.ts";
import { useTagFormStore } from "#/features/tag/form/tag-form.store.ts";

const SNAPSHOT_SKELETON_COLUMNS = [
  {
    cellClassName: stickyTableStartCellClassName,
    skeletonClassName: "size-4 rounded-sm",
    sticky: "start",
  },
  { skeletonClassName: "h-4 w-44" },
  { skeletonClassName: "h-4 w-64" },
  { skeletonClassName: "h-5 w-40 rounded-full" },
  { skeletonClassName: "h-4 w-36" },
  { skeletonClassName: "h-4 w-36" },
  {
    cellClassName: stickyTableEndCellClassName,
    skeletonClassName: "ml-auto size-7",
    sticky: "end",
  },
] as const;

export function SnapshotListPage() {
  const navigate = useNavigate();
  const credentials = useApiCredentials();
  const scopes = useActiveScopes();
  const canWrite = hasScope(scopes, "snapshots:write");
  const canCreateSession = hasScope(scopes, "sessions:write");
  const tenantReady = isTenantScopedQueryReady(credentials);

  const deleted = useSnapshotListPageStore((state) => state.deleted);
  const tags = useSnapshotListPageStore((state) => state.tags);
  const setDeleted = useSnapshotListPageStore((state) => state.setDeleted);
  const setTags = useSnapshotListPageStore((state) => state.setTags);

  const filters = useMemo(
    () => ({ includeDeleted: deleted !== "active", deleted, tags }),
    [deleted, tags],
  );

  const query = useSnapshotsInfiniteQuery(filters);
  const loadedSnapshots = useMemo(
    () => flattenInfinitePages(query.data?.pages),
    [query.data?.pages],
  );

  const detailSnapshot = useSnapshotListPageStore((state) => state.detailSnapshot);
  const detailSection = useSnapshotListPageStore((state) => state.detailSection);
  const showSnapshot = useSnapshotListPageStore((state) => state.showSnapshot);
  const setDetailSection = useSnapshotListPageStore((state) => state.setDetailSection);
  const initCreateSessionForm = useSessionFormStore((state) => state.initForm);
  const openCreateSessionModal = useSessionCreateModalStore((state) => state.openModal);
  const openCreatedSession = useSessionListPageStore((state) => state.openCreatedSession);
  const initTagForm = useTagFormStore((state) => state.initForm);
  const tagResourceKey = useTagFormStore((state) => state.formData.resourceKey);
  const tagModalOpen = useTagEditModalStore((state) => state.open);
  const openTagModal = useTagEditModalStore((state) => state.openModal);
  const selectedSnapshots = useSnapshotListPageStore((state) => state.selectedSnapshots);
  const confirmAction = useSnapshotListPageStore((state) => state.confirmAction);
  const toggleSnapshotSelection = useSnapshotListPageStore(
    (state) => state.toggleSnapshotSelection,
  );
  const clearSelectedSnapshots = useSnapshotListPageStore((state) => state.clearSelectedSnapshots);
  const removeSelectedSnapshot = useSnapshotListPageStore((state) => state.removeSelectedSnapshot);
  const setConfirmAction = useSnapshotListPageStore((state) => state.setConfirmAction);
  const selectedSnapshotItems = useMemo(
    () => Object.values(selectedSnapshots),
    [selectedSnapshots],
  );
  const tagsSnapshot =
    tagModalOpen && tagResourceKey?.startsWith("snapshot:") === true
      ? (loadedSnapshots.find((snapshot) => `snapshot:${snapshot.name}` === tagResourceKey) ?? null)
      : null;
  const batchTagsResourceKey =
    tagModalOpen && tagResourceKey?.startsWith("snapshots:batch:") === true ? tagResourceKey : null;
  const deletableSnapshotItems = selectedSnapshotItems.filter((snapshot) => !snapshot.deletedAt);
  const restorableSnapshotItems = selectedSnapshotItems.filter((snapshot) => snapshot.deletedAt);

  const deleteMutation = useDeleteSnapshotMutation();
  const restoreMutation = useRestoreSnapshotMutation();
  const replaceTagsMutation = useReplaceSnapshotTagsMutation();
  const updateSnapshotMutation = useUpdateSnapshotMutation();
  const [descriptionSnapshot, setDescriptionSnapshot] = useState<Snapshot | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState("");

  function handleCreateSession(snapshot: Snapshot) {
    setDetailSection(null);
    initCreateSessionForm({ baseSnapshot: snapshot.name });
    openCreateSessionModal();
  }

  function handleCreatedSession(result: CreateSessionResponse) {
    openCreatedSession(result);
    void navigate({ to: "/-/sessions" });
  }

  async function handleBatchDelete() {
    try {
      for (const snapshot of deletableSnapshotItems) {
        await deleteMutation.mutateAsync(snapshot.name);
      }
      clearSelectedSnapshots();
    } catch {
      return;
    }
  }

  async function handleBatchRestore() {
    try {
      for (const snapshot of restorableSnapshotItems) {
        await restoreMutation.mutateAsync(snapshot.name);
      }
      clearSelectedSnapshots();
    } catch {
      return;
    }
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
      case "delete":
        await deleteMutation.mutateAsync(action.snapshot.name);
        removeSelectedSnapshot(action.snapshot.id);
        return;
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  async function handleDescriptionSave() {
    if (!descriptionSnapshot) {
      return;
    }

    const result = await updateSnapshotMutation.mutateAsync({
      name: descriptionSnapshot.name,
      description: descriptionDraft === "" ? null : descriptionDraft,
    });
    if (detailSnapshot?.id === result.snapshot.id && detailSection) {
      showSnapshot(result.snapshot, detailSection);
    }
    setDescriptionSnapshot(null);
  }

  const confirmDialog =
    confirmAction?.kind === "batch-delete"
      ? {
          title: "Delete snapshots",
          description: `Delete ${deletableSnapshotItems.length} selected snapshot${deletableSnapshotItems.length === 1 ? "" : "s"}?`,
          confirmLabel: "Delete",
          variant: "destructive" as const,
        }
      : confirmAction?.kind === "delete"
        ? {
            title: "Delete snapshot",
            description: `Delete snapshot ${confirmAction.snapshot.name}?`,
            confirmLabel: "Delete",
            variant: "destructive" as const,
          }
        : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-3 p-3">
        <TenantRequiredNotice />
        {tenantReady ? (
          <div className="flex flex-wrap items-center gap-2">
            <DeletedStatusSelect value={deleted} onChange={setDeleted} />
            <TagFilter
              value={tags}
              availableTags={loadedSnapshots.flatMap((snapshot) =>
                snapshot.tags ? [snapshot.tags] : [],
              )}
              onChange={setTags}
            />
          </div>
        ) : null}
      </div>

      {tenantReady ? (
        <>
          <BatchActionBar
            selectedCount={selectedSnapshotItems.length}
            onClear={clearSelectedSnapshots}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                initTagForm(
                  "apply",
                  `snapshots:batch:${selectedSnapshotItems
                    .map((snapshot) => snapshot.id)
                    .join(",")}`,
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
              onClick={() => void handleBatchRestore()}
              disabled={
                !canWrite || restorableSnapshotItems.length === 0 || restoreMutation.isPending
              }
            >
              <RotateCcw data-icon="inline-start" />
              Restore
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setConfirmAction({ kind: "batch-delete" })}
              disabled={
                !canWrite || deletableSnapshotItems.length === 0 || deleteMutation.isPending
              }
            >
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          </BatchActionBar>

          <InfiniteTableShell
            query={query}
            emptyTitle="No snapshots"
            loading={
              <Table>
                <TableHeader>
                  <SnapshotTableHeader />
                </TableHeader>
                <TableBody>
                  <TableSkeletonRows columns={SNAPSHOT_SKELETON_COLUMNS} />
                </TableBody>
              </Table>
            }
          >
            {(items) => (
              <Table>
                <TableHeader>
                  <SnapshotTableHeader />
                </TableHeader>
                <TableBody>
                  {items.map((snapshot) => (
                    <SnapshotRow
                      key={snapshot.id}
                      snapshot={snapshot}
                      canWrite={canWrite}
                      canCreateSession={canCreateSession}
                      selected={Boolean(selectedSnapshots[snapshot.id])}
                      onSelectedChange={(selected) => toggleSnapshotSelection(snapshot, selected)}
                      onDetails={() => showSnapshot(snapshot, "details")}
                      onEvents={() => showSnapshot(snapshot, "events")}
                      onCreateSession={() => handleCreateSession(snapshot)}
                      onEditTags={() => {
                        initTagForm(
                          "edit",
                          `snapshot:${snapshot.name}`,
                          tagsToEntries(snapshot.tags ?? {}),
                        );
                        openTagModal();
                      }}
                      onEditDescription={() => {
                        setDescriptionSnapshot(snapshot);
                        setDescriptionDraft(snapshot.description ?? "");
                      }}
                      onRestore={() => void restoreMutation.mutateAsync(snapshot.name)}
                      onDelete={() => setConfirmAction({ kind: "delete", snapshot })}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </InfiniteTableShell>
        </>
      ) : null}

      <TagEditModal
        resourceKey={tagsSnapshot ? `snapshot:${tagsSnapshot.name}` : null}
        title="Edit tags"
        onSave={async (tags) => {
          if (!tagsSnapshot) {
            return;
          }
          await replaceTagsMutation.mutateAsync({ name: tagsSnapshot.name, tags });
        }}
      />

      <TagEditModal
        resourceKey={batchTagsResourceKey}
        title="Apply tags"
        onSave={async (tags) => {
          for (const snapshot of selectedSnapshotItems) {
            await replaceTagsMutation.mutateAsync({
              name: snapshot.name,
              tags: { ...snapshot.tags, ...tags },
            });
          }
          clearSelectedSnapshots();
        }}
      />

      <SnapshotDetailModals
        snapshot={detailSnapshot}
        section={detailSection}
        onSectionChange={setDetailSection}
        canCreateSession={canCreateSession}
        onCreateSession={handleCreateSession}
      />
      <SessionCreateModal onCreated={handleCreatedSession} />
      <SnapshotDescriptionModal
        snapshot={descriptionSnapshot}
        value={descriptionDraft}
        pending={updateSnapshotMutation.isPending}
        onValueChange={setDescriptionDraft}
        onOpenChange={(open) => {
          if (!open) {
            setDescriptionSnapshot(null);
          }
        }}
        onSave={handleDescriptionSave}
      />

      {confirmDialog ? (
        <ConfirmDialog
          open={confirmAction !== null}
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmLabel={confirmDialog.confirmLabel}
          variant={confirmDialog.variant}
          pending={deleteMutation.isPending}
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

function SnapshotTableHeader() {
  return (
    <TableRow>
      <TableHead data-table-sticky="start" className={stickyTableStartHeaderClassName} />
      <TableHead>Name</TableHead>
      <TableHead>Description</TableHead>
      <TableHead>Tags</TableHead>
      <TableHead>Created</TableHead>
      <TableHead>Expires</TableHead>
      <TableHead data-table-sticky="end" className={stickyTableEndHeaderClassName} />
    </TableRow>
  );
}

type SnapshotRowProps = {
  snapshot: Snapshot;
  canWrite: boolean;
  canCreateSession: boolean;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onDetails: () => void;
  onEvents: () => void;
  onCreateSession: () => void;
  onEditDescription: () => void;
  onEditTags: () => void;
  onRestore: () => void;
  onDelete: () => void;
};

function SnapshotRow({
  snapshot,
  canWrite,
  canCreateSession,
  selected,
  onSelectedChange,
  onDetails,
  onEvents,
  onCreateSession,
  onEditDescription,
  onEditTags,
  onRestore,
  onDelete,
}: SnapshotRowProps) {
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      className="cursor-pointer"
      onClick={onDetails}
    >
      <TableCell
        data-table-sticky="start"
        className={`${stickyTableStartCellClassName} ${canWrite ? "cursor-pointer" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          if (canWrite) {
            onSelectedChange(!selected);
          }
        }}
      >
        <Checkbox
          aria-label={`Select snapshot ${snapshot.name}`}
          checked={selected}
          disabled={!canWrite}
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={onSelectedChange}
        />
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-2">
          {snapshot.name}
          <DeletedBadge deletedAt={snapshot.deletedAt} />
        </span>
      </TableCell>
      <TableCell className="max-w-80 truncate text-muted-foreground">
        {snapshot.description ?? "—"}
      </TableCell>
      <TableCell>
        <TagBadges tags={snapshot.tags} />
      </TableCell>
      <TableCell className="text-muted-foreground">{formatTimestamp(snapshot.createdAt)}</TableCell>
      <TableCell className="text-muted-foreground">{formatTimestamp(snapshot.expiresAt)}</TableCell>
      <TableCell
        data-table-sticky="end"
        className={stickyTableEndCellClassName}
        onClick={(event) => event.stopPropagation()}
      >
        <SnapshotActionsMenu
          snapshot={snapshot}
          canWrite={canWrite}
          canCreateSession={canCreateSession}
          onDetails={onDetails}
          onEvents={onEvents}
          onCreateSession={onCreateSession}
          onEditDescription={onEditDescription}
          onEditTags={onEditTags}
          onRestore={onRestore}
          onDelete={onDelete}
        />
      </TableCell>
    </TableRow>
  );
}

type SnapshotActionsMenuProps = {
  snapshot: Snapshot;
  canWrite: boolean;
  canCreateSession: boolean;
  onDetails: () => void;
  onEvents: () => void;
  onCreateSession: () => void;
  onEditDescription: () => void;
  onEditTags: () => void;
  onRestore: () => void;
  onDelete: () => void;
};

function SnapshotActionsMenu({
  snapshot,
  canWrite,
  canCreateSession,
  onDetails,
  onEvents,
  onCreateSession,
  onEditDescription,
  onEditTags,
  onRestore,
  onDelete,
}: SnapshotActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${snapshot.name}`} />
        }
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onDetails}>Details</DropdownMenuItem>
          <DropdownMenuItem onClick={onEvents}>Events</DropdownMenuItem>
          {canCreateSession && !snapshot.deletedAt ? (
            <DropdownMenuItem onClick={onCreateSession}>
              <AppWindow />
              Create session
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        {canWrite ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onEditDescription}>Edit description</DropdownMenuItem>
              <DropdownMenuItem onClick={onEditTags}>Edit tags</DropdownMenuItem>
              {snapshot.deletedAt ? (
                <DropdownMenuItem onClick={onRestore}>Restore</DropdownMenuItem>
              ) : (
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type SnapshotDescriptionModalProps = {
  snapshot: Snapshot | null;
  value: string;
  pending: boolean;
  onValueChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSave: () => Promise<void>;
};

function SnapshotDescriptionModal({
  snapshot,
  value,
  pending,
  onValueChange,
  onOpenChange,
  onSave,
}: SnapshotDescriptionModalProps) {
  return (
    <Dialog open={snapshot !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{snapshot ? `Edit ${snapshot.name}` : "Edit description"}</DialogTitle>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="snapshot-description">Description</FieldLabel>
            <Textarea
              id="snapshot-description"
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
              disabled={pending}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void onSave()} disabled={pending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
