import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import { Pencil, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { DescribeDialog } from "#/components/describe-dialog.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { TagList } from "#/components/tag-list.tsx";
import { useOpenNewSession } from "#/features/session/session.mutations.ts";
import {
  useDeleteSnapshotMutation,
  useDescribeSnapshotMutation,
} from "#/features/snapshot/snapshot.mutations.ts";
import { type Snapshot, useSnapshotsQuery } from "#/features/snapshot/snapshot.queries.ts";
import { useSelectedWorkspace } from "#/features/workspace/workspace.queries.ts";
import { told } from "#/lib/api.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function SnapshotRow({ snapshot }: { snapshot: Snapshot }) {
  const openNew = useOpenNewSession();
  const remove = useDeleteSnapshotMutation();
  const describe = useDescribeSnapshotMutation();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);

  const start = () =>
    openNew({
      snapshotId: snapshot.id,
      ...(snapshot.workspaceId === null ? {} : { workspaceId: snapshot.workspaceId }),
    });

  return (
    <TableRow data-console-snapshot={snapshot.id}>
      <TableCell>
        <div className="aperture:grid aperture:gap-0.5">
          <span className="aperture:font-medium">{snapshot.name ?? "Unnamed"}</span>
          {snapshot.description === null ? null : (
            <span className="aperture:max-w-96 aperture:truncate aperture:text-sm aperture:text-muted-foreground">
              {snapshot.description}
            </span>
          )}
          <span className="aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
            {snapshot.id}
          </span>
          <TagList tags={snapshot.tags} />
        </div>
      </TableCell>
      <TableCell>
        <Badge variant="outline">{snapshot.shared ? "shared" : "one node"}</Badge>
      </TableCell>
      <TableCell className="aperture:text-muted-foreground">
        {when.format(new Date(snapshot.createdAt.epochMilliseconds))}
      </TableCell>
      <TableCell>
        <div className="aperture:flex aperture:justify-end aperture:gap-1">
          <Button
            size="sm"
            variant="outline"
            data-console-snapshot-start
            onClick={() => void start()}
          >
            <Play />
            New session
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(true)}>
            <Pencil />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete"
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
          </Button>
        </div>
        <DescribeDialog
          title="Edit snapshot"
          nameLabel="Name"
          withDescription
          initial={snapshot}
          open={editing}
          onOpenChange={setEditing}
          onSubmit={(said) => describe.mutateAsync({ id: snapshot.id, ...said })}
        />
        <ConfirmDialog
          open={confirming}
          title="Delete this snapshot?"
          description="Sessions created from it keep working."
          confirmLabel="Delete"
          variant="destructive"
          pending={remove.isPending}
          onOpenChange={setConfirming}
          onConfirm={() => remove.mutate(snapshot.id, { onSettled: () => setConfirming(false) })}
        />
      </TableCell>
    </TableRow>
  );
}

/** An account's snapshots: what its sessions are started from. */
export function SnapshotsPage() {
  const snapshots = useSnapshotsQuery();
  const workspace = useSelectedWorkspace();
  const shown = snapshots.data?.filter(
    (snapshot) => snapshot.workspaceId === (workspace?.id ?? null),
  );

  if (snapshots.isError) {
    return (
      <p role="alert" className="aperture:p-4 aperture:text-sm aperture:text-destructive">
        {told(snapshots.error)}
      </p>
    );
  }
  if (shown?.length === 0) {
    return (
      <p
        data-console-empty
        className="aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
      >
        No snapshots yet. Save one from a session's menu.
      </p>
    );
  }
  return (
    <TablePage>
      <Table stickyActionColumn>
        <TableHeader>
          <TableRow>
            <TableHead>Snapshot</TableHead>
            <TableHead>Kept</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="aperture:w-px" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown?.map((snapshot) => (
            <SnapshotRow key={snapshot.id} snapshot={snapshot} />
          ))}
        </TableBody>
      </Table>
    </TablePage>
  );
}
