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
import { Pencil, Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { LongName } from "#/components/long-name.tsx";
import { NameDialog } from "#/components/name-dialog.tsx";
import { type RowAction, RowActions, RowContextMenu } from "#/components/row-actions.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { useAccess, useMay } from "#/features/auth/access.ts";
import { WorkspaceMembersDialog } from "#/features/workspace/workspace-members-dialog.tsx";
import {
  useCreateWorkspaceMutation,
  useDeleteWorkspaceMutation,
  useRenameWorkspaceMutation,
  useWorkspacesQuery,
  type Workspace,
} from "#/features/workspace/workspace.queries.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
  const access = useAccess();
  const remove = useDeleteWorkspaceMutation();
  const rename = useRenameWorkspaceMutation();
  const [dialog, setDialog] = useState<"members" | "rename" | "delete" | null>(null);
  // Who is in it is told to all its members, and changed by its admins alone.
  const administers =
    access.may("workspaces:write") && (workspace.role === "admin" || access.may("admin"));
  const actions: ReadonlyArray<RowAction> = [
    {
      key: "members",
      label: "Members",
      icon: Users,
      shown: "button",
      onSelect: () => setDialog("members"),
    },
    ...(administers
      ? ([
          { key: "rename", label: "Rename", icon: Pencil, onSelect: () => setDialog("rename") },
          {
            key: "delete",
            label: "Delete",
            icon: Trash2,
            destructive: true,
            parted: true,
            onSelect: () => setDialog("delete"),
          },
        ] satisfies ReadonlyArray<RowAction>)
      : []),
  ];

  return (
    <RowContextMenu actions={actions}>
      <TableRow data-console-workspace={workspace.name}>
        <TableCell className="aperture:font-medium">
          <LongName>{workspace.name}</LongName>
        </TableCell>
        <TableCell>
          <Badge variant={workspace.role === "admin" ? "default" : "outline"}>
            {workspace.role ?? "not a member"}
          </Badge>
        </TableCell>
        <TableCell label="Created" className="aperture:text-muted-foreground">
          {when.format(new Date(workspace.createdAt.epochMilliseconds))}
        </TableCell>
        <TableCell>
          <RowActions actions={actions} label="Workspace actions" />
          <NameDialog
            title="Rename workspace"
            initial={workspace.name}
            submitLabel="Rename"
            open={dialog === "rename"}
            onOpenChange={(open) => setDialog(open ? "rename" : null)}
            onSubmit={(name) => rename.mutateAsync({ id: workspace.id, name })}
          />
          <WorkspaceMembersDialog
            workspace={workspace}
            administers={administers}
            open={dialog === "members"}
            onOpenChange={(open) => setDialog(open ? "members" : null)}
          />
          <ConfirmDialog
            open={dialog === "delete"}
            title={`Delete ${workspace.name}?`}
            description="Only a workspace with no sessions and no snapshots left is deleted."
            confirmLabel="Delete"
            variant="destructive"
            pending={remove.isPending}
            onOpenChange={(open) => setDialog(open ? "delete" : null)}
            onConfirm={() => remove.mutate(workspace.id, { onSettled: () => setDialog(null) })}
          />
        </TableCell>
      </TableRow>
    </RowContextMenu>
  );
}

/** The workspaces the account is in. */
export function WorkspacesPage() {
  const workspaces = useWorkspacesQuery();
  const create = useCreateWorkspaceMutation();
  const [creating, setCreating] = useState(false);
  const makes = useMay("workspaces:write");

  return (
    <TablePage>
      <PageHeaderActions>
        {makes ? (
          <Button data-console-workspace-new size="sm" onClick={() => setCreating(true)}>
            <Plus />
            New workspace
          </Button>
        ) : null}
      </PageHeaderActions>
      <NameDialog
        title="New workspace"
        open={creating}
        onOpenChange={setCreating}
        onSubmit={(name) => create.mutateAsync(name)}
      />
      {workspaces.data?.length === 0 ? (
        <p
          data-console-empty
          className="aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
        >
          No workspaces yet.
        </p>
      ) : (
        <Table stickyActionColumn>
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="aperture:w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {workspaces.data?.map((workspace) => (
              <WorkspaceRow key={workspace.id} workspace={workspace} />
            ))}
          </TableBody>
        </Table>
      )}
    </TablePage>
  );
}
