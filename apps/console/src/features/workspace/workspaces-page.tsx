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
import { Building2, LogIn, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { filter, Filters } from "#/components/filter-menu.tsx";
import { LongName } from "#/components/long-name.tsx";
import { NameDialog } from "#/components/name-dialog.tsx";
import { type RowAction, RowActions, RowContextMenu } from "#/components/row-actions.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { TableRowsSkeleton } from "#/components/list-skeleton.tsx";
import { told } from "#/lib/api.ts";
import { useAccess, useMay } from "#/features/auth/access.ts";
import { WorkspaceMembersDialog } from "#/features/workspace/workspace-members-dialog.tsx";
import { showEveryWorkspace } from "#/features/workspace/selected-workspace.ts";
import {
  useCreateWorkspaceMutation,
  useDeleteWorkspaceMutation,
  useJoinWorkspaceMutation,
  useRenameWorkspaceMutation,
  useShownWorkspaces,
  type Workspace,
} from "#/features/workspace/workspace.queries.ts";
import { ListEmpty } from "#/components/list-empty.tsx";
import { worded } from "#/lib/words.ts";
import { when } from "#/lib/when.ts";

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
  const access = useAccess();
  const remove = useDeleteWorkspaceMutation();
  const rename = useRenameWorkspaceMutation();
  const join = useJoinWorkspaceMutation();
  const [dialog, setDialog] = useState<"members" | "rename" | "delete" | null>(null);
  // Who is in it is told to all its members, and changed by its admins alone.
  const administers =
    access.may("workspaces:write") && (workspace.role === "admin" || access.may("admin"));
  const actions: ReadonlyArray<RowAction> = [
    ...(workspace.role === null && administers
      ? ([
          {
            key: "join",
            label: "Join",
            icon: LogIn,
            shown: "button",
            disabled: join.isPending,
            onSelect: () => join.mutate(workspace.id),
          },
        ] satisfies ReadonlyArray<RowAction>)
      : []),
    ...(access.may("workspaces:read")
      ? ([
          {
            key: "members",
            label: "Members",
            icon: Users,
            shown: "button",
            onSelect: () => setDialog("members"),
          },
        ] satisfies ReadonlyArray<RowAction>)
      : []),
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
          {workspace.role === null ? (
            <Badge
              variant="outline"
              data-console-workspace-onlooked
              className="aperture:text-muted-foreground"
            >
              Not a member · read only
            </Badge>
          ) : (
            <Badge variant={workspace.role === "admin" ? "default" : "outline"}>
              {worded(workspace.role)}
            </Badge>
          )}
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

const SHOWN = [
  { value: "joined", label: "My workspaces" },
  { value: "every", label: "All workspaces" },
] as const;

/** The workspaces the account is in; for an admin who asks, every one there is. */
export function WorkspacesPage() {
  const { workspaces, joined, others, offersEvery, showsEvery } = useShownWorkspaces();
  const shown = [...joined, ...others];
  const create = useCreateWorkspaceMutation();
  const [creating, setCreating] = useState(false);
  const makes = useMay("workspaces:write");

  return (
    <TablePage>
      <PageHeaderActions>
        {offersEvery ? (
          <Filters
            filters={[
              filter({
                label: "Shown",
                value: showsEvery ? "every" : "joined",
                options: SHOWN,
                onChange: (value) => showEveryWorkspace(value === "every"),
              }),
            ]}
          />
        ) : null}
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
      {workspaces.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(workspaces.error)}
        </p>
      ) : workspaces.isSuccess && shown.length === 0 ? (
        <ListEmpty icon={Building2} title="No workspaces yet">
          {makes ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              New workspace
            </Button>
          ) : null}
        </ListEmpty>
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
            {workspaces.isPending ? <TableRowsSkeleton columns={4} actions /> : null}
            {shown.map((workspace) => (
              <WorkspaceRow key={workspace.id} workspace={workspace} />
            ))}
          </TableBody>
        </Table>
      )}
    </TablePage>
  );
}
