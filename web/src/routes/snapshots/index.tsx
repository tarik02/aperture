import { createFileRoute } from "@tanstack/react-router";
import { MoreHorizontal, RotateCcw, Tags as TagsIcon, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  SnapshotDetailModals,
  type SnapshotDetailSection,
} from "#/components/snapshots/snapshot-detail-modals.tsx";
import { BatchActionBar } from "#/components/resources/batch-action-bar.tsx";
import { EditTagsDialog } from "#/components/resources/edit-tags-dialog.tsx";
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
  DropdownMenu,
  DropdownMenuContent,
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
} from "#/hooks/mutations/use-snapshot-mutations.ts";
import { useSnapshotsInfiniteQuery } from "#/hooks/queries/use-snapshots-query.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import { formatTimestamp } from "#/lib/format.ts";
import type { DeletedFilterValue } from "#/hooks/queries/keys.ts";
import type { TagFilterValue } from "#/lib/tag-filter.ts";
import type { Snapshot } from "#/lib/api/schemas.ts";

export const Route = createFileRoute("/snapshots/")({
  component: SnapshotsPage,
});

const SNAPSHOT_SKELETON_COLUMNS = [
  {
    cellClassName: stickyTableStartCellClassName,
    skeletonClassName: "size-4 rounded-sm",
    sticky: "start",
  },
  { skeletonClassName: "h-4 w-44" },
  { skeletonClassName: "h-5 w-40 rounded-full" },
  { skeletonClassName: "h-4 w-36" },
  { skeletonClassName: "h-4 w-36" },
  {
    cellClassName: stickyTableEndCellClassName,
    skeletonClassName: "ml-auto size-7",
    sticky: "end",
  },
] as const;

function SnapshotsPage() {
  const credentials = useApiCredentials();
  const scopes = useActiveScopes();
  const canWrite = hasScope(scopes, "snapshots:write");
  const tenantReady = isTenantScopedQueryReady(credentials);

  const [deleted, setDeleted] = useState<DeletedFilterValue>("active");
  const [tags, setTags] = useState<TagFilterValue | undefined>();

  const filters = useMemo(
    () => ({ includeDeleted: deleted !== "active", deleted, tags }),
    [deleted, tags],
  );

  const query = useSnapshotsInfiniteQuery(filters);
  const loadedSnapshots = useMemo(
    () => flattenInfinitePages(query.data?.pages),
    [query.data?.pages],
  );

  const [detailSnapshot, setDetailSnapshot] = useState<Snapshot | null>(null);
  const [detailSection, setDetailSection] = useState<SnapshotDetailSection | null>(null);
  const [tagsSnapshot, setTagsSnapshot] = useState<Snapshot | null>(null);
  const [batchTagsOpen, setBatchTagsOpen] = useState(false);
  const [selectedSnapshots, setSelectedSnapshots] = useState<Record<string, Snapshot>>({});
  const selectedSnapshotItems = useMemo(
    () => Object.values(selectedSnapshots),
    [selectedSnapshots],
  );
  const deletableSnapshotItems = selectedSnapshotItems.filter((snapshot) => !snapshot.deletedAt);
  const restorableSnapshotItems = selectedSnapshotItems.filter((snapshot) => snapshot.deletedAt);

  const deleteMutation = useDeleteSnapshotMutation();
  const restoreMutation = useRestoreSnapshotMutation();
  const replaceTagsMutation = useReplaceSnapshotTagsMutation();

  function showSnapshot(snapshot: Snapshot, section: SnapshotDetailSection = "details") {
    setDetailSnapshot(snapshot);
    setDetailSection(section);
  }

  function toggleSnapshotSelection(snapshot: Snapshot, selected: boolean) {
    setSelectedSnapshots((current) => {
      const next = { ...current };
      if (selected) {
        next[snapshot.id] = snapshot;
      } else {
        delete next[snapshot.id];
      }
      return next;
    });
  }

  async function handleBatchDelete() {
    try {
      for (const snapshot of deletableSnapshotItems) {
        await deleteMutation.mutateAsync(snapshot.name);
      }
      setSelectedSnapshots({});
    } catch {
      return;
    }
  }

  async function handleBatchRestore() {
    try {
      for (const snapshot of restorableSnapshotItems) {
        await restoreMutation.mutateAsync(snapshot.name);
      }
      setSelectedSnapshots({});
    } catch {
      return;
    }
  }

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
            onClear={() => setSelectedSnapshots({})}
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
              onClick={() => void handleBatchDelete()}
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
                      selected={Boolean(selectedSnapshots[snapshot.id])}
                      onSelectedChange={(selected) => toggleSnapshotSelection(snapshot, selected)}
                      onDetails={() => showSnapshot(snapshot, "details")}
                      onEvents={() => showSnapshot(snapshot, "events")}
                      onEditTags={() => setTagsSnapshot(snapshot)}
                      onRestore={() => void restoreMutation.mutateAsync(snapshot.name)}
                      onDelete={() => void deleteMutation.mutateAsync(snapshot.name)}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </InfiniteTableShell>
        </>
      ) : null}

      <EditTagsDialog
        open={tagsSnapshot !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTagsSnapshot(null);
          }
        }}
        resourceKey={tagsSnapshot ? `snapshot:${tagsSnapshot.name}` : null}
        title="Edit tags"
        initialTags={tagsSnapshot?.tags}
        onSave={async (tags) => {
          if (!tagsSnapshot) {
            return;
          }
          await replaceTagsMutation.mutateAsync({ name: tagsSnapshot.name, tags });
        }}
      />

      <EditTagsDialog
        open={batchTagsOpen}
        onOpenChange={setBatchTagsOpen}
        resourceKey={
          batchTagsOpen
            ? `snapshots:batch:${selectedSnapshotItems.map((snapshot) => snapshot.id).join(",")}`
            : null
        }
        title="Apply tags"
        onSave={async (tags) => {
          for (const snapshot of selectedSnapshotItems) {
            await replaceTagsMutation.mutateAsync({
              name: snapshot.name,
              tags: { ...snapshot.tags, ...tags },
            });
          }
          setSelectedSnapshots({});
        }}
      />

      <SnapshotDetailModals
        snapshot={detailSnapshot}
        section={detailSection}
        onSectionChange={setDetailSection}
      />
    </div>
  );
}

function SnapshotTableHeader() {
  return (
    <TableRow>
      <TableHead data-table-sticky="start" className={stickyTableStartHeaderClassName} />
      <TableHead>Name</TableHead>
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
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onDetails: () => void;
  onEvents: () => void;
  onEditTags: () => void;
  onRestore: () => void;
  onDelete: () => void;
};

function SnapshotRow({
  snapshot,
  canWrite,
  selected,
  onSelectedChange,
  onDetails,
  onEvents,
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
        className={stickyTableStartCellClassName}
        onClick={(event) => event.stopPropagation()}
      >
        <Checkbox
          aria-label={`Select snapshot ${snapshot.name}`}
          checked={selected}
          disabled={!canWrite}
          onCheckedChange={onSelectedChange}
        />
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-2">
          {snapshot.name}
          <DeletedBadge deletedAt={snapshot.deletedAt} />
        </span>
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
          onDetails={onDetails}
          onEvents={onEvents}
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
  onDetails: () => void;
  onEvents: () => void;
  onEditTags: () => void;
  onRestore: () => void;
  onDelete: () => void;
};

function SnapshotActionsMenu({
  snapshot,
  canWrite,
  onDetails,
  onEvents,
  onEditTags,
  onRestore,
  onDelete,
}: SnapshotActionsMenuProps) {
  if (!canWrite) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" />}
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onDetails}>Details</DropdownMenuItem>
        <DropdownMenuItem onClick={onEvents}>Events</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onEditTags}>Edit tags</DropdownMenuItem>
        {snapshot.deletedAt ? (
          <DropdownMenuItem onClick={onRestore}>Restore</DropdownMenuItem>
        ) : (
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
