import { useNavigate } from "@tanstack/react-router";
import {
  AppWindow,
  Info,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Tags as TagsIcon,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { SnapshotDetailModals } from "#/components/snapshots/snapshot-detail-modals.tsx";
import { BatchActionBar } from "#/components/resources/batch-action-bar.tsx";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { SessionCreateModal } from "#/features/session/create-modal/session-create-modal.tsx";
import { TagEditModal } from "#/features/tag/edit-modal/tag-edit-modal.tsx";
import {
  TagEditor,
  entriesToTags,
  tagsToEntries,
  type TagEntry,
} from "#/components/resources/tag-editor.tsx";
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

type SnapshotEditDraft = {
  snapshot: Snapshot;
  description: string;
  tagEntries: TagEntry[];
};

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
  const batchTagsResourceKey =
    tagResourceKey?.startsWith("snapshots:batch:") === true ? tagResourceKey : null;
  const deletableSnapshotItems = selectedSnapshotItems.filter((snapshot) => !snapshot.deletedAt);
  const restorableSnapshotItems = selectedSnapshotItems.filter((snapshot) => snapshot.deletedAt);

  const deleteMutation = useDeleteSnapshotMutation();
  const restoreMutation = useRestoreSnapshotMutation();
  const replaceTagsMutation = useReplaceSnapshotTagsMutation();
  const updateSnapshotMutation = useUpdateSnapshotMutation();
  const [editDraft, setEditDraft] = useState<SnapshotEditDraft | null>(null);

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

  async function handleSnapshotSave() {
    if (!editDraft) {
      return;
    }

    let updatedSnapshot = editDraft.snapshot;
    const nextDescription = editDraft.description === "" ? null : editDraft.description;
    if (nextDescription !== editDraft.snapshot.description) {
      const result = await updateSnapshotMutation.mutateAsync({
        name: editDraft.snapshot.name,
        description: nextDescription,
      });
      updatedSnapshot = result.snapshot;
      setEditDraft((currentDraft) =>
        currentDraft?.snapshot.id === result.snapshot.id
          ? { ...currentDraft, snapshot: result.snapshot }
          : currentDraft,
      );
    }

    const nextTags = entriesToTags(editDraft.tagEntries);
    if (!tagsEqual(nextTags, editDraft.snapshot.tags ?? {})) {
      const result = await replaceTagsMutation.mutateAsync({
        name: editDraft.snapshot.name,
        tags: nextTags,
      });
      updatedSnapshot = result.snapshot;
    }

    if (detailSnapshot?.id === updatedSnapshot.id && detailSection) {
      showSnapshot(updatedSnapshot, detailSection);
    }
    setEditDraft(null);
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
                      onCreateSession={() => handleCreateSession(snapshot)}
                      onEdit={() => {
                        setEditDraft({
                          snapshot,
                          description: snapshot.description ?? "",
                          tagEntries: tagsToEntries(snapshot.tags ?? {}),
                        });
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
      <SnapshotEditModal
        draft={editDraft}
        pending={updateSnapshotMutation.isPending || replaceTagsMutation.isPending}
        onDescriptionChange={(description) =>
          setEditDraft((draft) => (draft ? { ...draft, description } : null))
        }
        onTagEntriesChange={(tagEntries) =>
          setEditDraft((draft) => (draft ? { ...draft, tagEntries } : null))
        }
        onOpenChange={(open) => {
          if (!open) {
            setEditDraft(null);
          }
        }}
        onSave={handleSnapshotSave}
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
  onCreateSession: () => void;
  onEdit: () => void;
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
  onCreateSession,
  onEdit,
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
          onCreateSession={onCreateSession}
          onEdit={onEdit}
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
  onCreateSession: () => void;
  onEdit: () => void;
  onRestore: () => void;
  onDelete: () => void;
};

function SnapshotActionsMenu({
  snapshot,
  canWrite,
  canCreateSession,
  onDetails,
  onCreateSession,
  onEdit,
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
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onDetails}>
            <Info />
            Snapshot details
          </DropdownMenuItem>
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
              <DropdownMenuItem onClick={onEdit}>
                <Pencil />
                Edit
              </DropdownMenuItem>
              {snapshot.deletedAt ? (
                <DropdownMenuItem onClick={onRestore}>
                  <RotateCcw />
                  Restore
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2 />
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

type SnapshotEditModalProps = {
  draft: SnapshotEditDraft | null;
  pending: boolean;
  onDescriptionChange: (description: string) => void;
  onTagEntriesChange: (tagEntries: TagEntry[]) => void;
  onOpenChange: (open: boolean) => void;
  onSave: () => Promise<void>;
};

function SnapshotEditModal({
  draft,
  pending,
  onDescriptionChange,
  onTagEntriesChange,
  onOpenChange,
  onSave,
}: SnapshotEditModalProps) {
  return (
    <Dialog open={draft !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(80vh,720px)] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft ? `Edit ${draft.snapshot.name}` : "Edit snapshot"}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto py-2">
          <FieldGroup>
            <Field data-disabled={pending ? true : undefined}>
              <FieldLabel htmlFor="snapshot-description">Description</FieldLabel>
              <Textarea
                id="snapshot-description"
                value={draft?.description ?? ""}
                onChange={(event) => onDescriptionChange(event.target.value)}
                disabled={pending}
              />
            </Field>
            <TagEditor
              entries={draft?.tagEntries ?? []}
              onChange={onTagEntriesChange}
              disabled={pending}
            />
          </FieldGroup>
        </div>
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

function tagsEqual(left: Record<string, string>, right: Record<string, string>) {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }
  return leftEntries.every(([key, value]) => right[key] === value);
}
