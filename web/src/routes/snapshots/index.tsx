import { createFileRoute } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { SnapshotDetailDrawer } from "#/components/snapshots/snapshot-detail-drawer.tsx";
import { EditTagsDialog } from "#/components/resources/edit-tags-dialog.tsx";
import { IncludeDeletedToggle } from "#/components/resources/include-deleted-toggle.tsx";
import { InfiniteTableShell } from "#/components/resources/infinite-table-shell.tsx";
import { DeletedBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { TagFilter } from "#/components/resources/tag-filter.tsx";
import { TenantRequiredNotice } from "#/components/resources/tenant-required.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table.tsx";
import {
  useDeleteSnapshotMutation,
  useReplaceSnapshotTagsMutation,
  useRestoreSnapshotMutation,
} from "#/hooks/mutations/use-snapshot-mutations.ts";
import { useSnapshotsInfiniteQuery } from "#/hooks/queries/use-snapshots-query.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { formatTimestamp } from "#/lib/format.ts";
import type { Snapshot } from "#/lib/api/schemas.ts";

export const Route = createFileRoute("/snapshots/")({
  component: SnapshotsPage,
});

function SnapshotsPage() {
  const credentials = useApiCredentials();
  const scopes = useActiveScopes();
  const canWrite = hasScope(scopes, "snapshots:write");
  const tenantReady = isTenantScopedQueryReady(credentials);

  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [tagKey, setTagKey] = useState<string | undefined>();
  const [tagValue, setTagValue] = useState<string | undefined>();

  const filters = useMemo(
    () => ({ includeDeleted, tagKey, tagValue }),
    [includeDeleted, tagKey, tagValue],
  );

  const query = useSnapshotsInfiniteQuery(filters);

  const [detailSnapshot, setDetailSnapshot] = useState<Snapshot | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [tagsSnapshot, setTagsSnapshot] = useState<Snapshot | null>(null);

  const deleteMutation = useDeleteSnapshotMutation();
  const restoreMutation = useRestoreSnapshotMutation();
  const replaceTagsMutation = useReplaceSnapshotTagsMutation();

  function openDetail(snapshot: Snapshot) {
    setDetailSnapshot(snapshot);
    setDetailOpen(true);
  }

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Snapshots</h1>

      <TenantRequiredNotice />

      {tenantReady ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <IncludeDeletedToggle checked={includeDeleted} onCheckedChange={setIncludeDeleted} />
            <TagFilter
              tagKey={tagKey}
              tagValue={tagValue}
              onApply={(nextKey, nextValue) => {
                setTagKey(nextKey);
                setTagValue(nextValue);
              }}
            />
          </div>

          <InfiniteTableShell query={query} emptyTitle="No snapshots">
            {(items) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((snapshot) => (
                    <TableRow
                      key={snapshot.id}
                      className="cursor-pointer"
                      onClick={() => openDetail(snapshot)}
                    >
                      <TableCell>
                        <span className="flex items-center gap-2">
                          {snapshot.name}
                          <DeletedBadge deletedAt={snapshot.deletedAt} />
                        </span>
                      </TableCell>
                      <TableCell>
                        <TagBadges tags={snapshot.tags} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatTimestamp(snapshot.createdAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatTimestamp(snapshot.expiresAt)}
                      </TableCell>
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        {canWrite ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={<Button variant="ghost" size="icon-sm" />}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <MoreHorizontal />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setTagsSnapshot(snapshot)}>
                                Edit tags
                              </DropdownMenuItem>
                              {snapshot.deletedAt ? (
                                <DropdownMenuItem
                                  onClick={() => void restoreMutation.mutateAsync(snapshot.name)}
                                >
                                  Restore
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => void deleteMutation.mutateAsync(snapshot.name)}
                                >
                                  Delete
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </TableCell>
                    </TableRow>
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
        title="Edit tags"
        initialTags={tagsSnapshot?.tags}
        onSave={async (tags) => {
          if (!tagsSnapshot) {
            return;
          }
          await replaceTagsMutation.mutateAsync({ name: tagsSnapshot.name, tags });
        }}
      />

      <SnapshotDetailDrawer
        snapshot={detailSnapshot}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </div>
  );
}
