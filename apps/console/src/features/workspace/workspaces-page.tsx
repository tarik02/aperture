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
import { Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { NameDialog } from "#/components/name-dialog.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { WorkspaceMembersDialog } from "#/features/workspace/workspace-members-dialog.tsx";
import {
  useCreateWorkspaceMutation,
  useDeleteWorkspaceMutation,
  useWorkspacesQuery,
  type Workspace,
} from "#/features/workspace/workspace.queries.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
  const account = useAccountQuery();
  const remove = useDeleteWorkspaceMutation();
  const [dialog, setDialog] = useState<"members" | "delete" | null>(null);
  const administers = workspace.role === "admin" || account.data?.admin === true;

  return (
    <TableRow data-console-workspace={workspace.name}>
      <TableCell className="aperture:font-medium">{workspace.name}</TableCell>
      <TableCell>
        <Badge variant={workspace.role === "admin" ? "default" : "outline"}>
          {workspace.role ?? "not a member"}
        </Badge>
      </TableCell>
      <TableCell className="aperture:text-muted-foreground">
        {when.format(new Date(workspace.createdAt.epochMilliseconds))}
      </TableCell>
      <TableCell>
        <div className="aperture:flex aperture:justify-end aperture:gap-1">
          <Button size="sm" variant="outline" onClick={() => setDialog("members")}>
            <Users />
            Members
          </Button>
          {administers ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Delete"
              onClick={() => setDialog("delete")}
            >
              <Trash2 />
            </Button>
          ) : null}
        </div>
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
  );
}

/** The workspaces the account is in. */
export function WorkspacesPage() {
  const workspaces = useWorkspacesQuery();
  const create = useCreateWorkspaceMutation();
  const [creating, setCreating] = useState(false);

  return (
    <div className="aperture:p-4">
      <PageHeaderActions>
        <Button data-console-workspace-new size="sm" onClick={() => setCreating(true)}>
          <Plus />
          New workspace
        </Button>
      </PageHeaderActions>
      <NameDialog
        title="New workspace"
        description="Its members all have its sessions and snapshots."
        open={creating}
        onOpenChange={setCreating}
        onSubmit={(name) => create.mutateAsync(name)}
      />
      {workspaces.data?.length === 0 ? (
        <p
          data-console-empty
          className="aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
        >
          No workspaces yet. Make one to keep sessions and snapshots with others.
        </p>
      ) : (
        <Table scrollable={false}>
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {workspaces.data?.map((workspace) => (
              <WorkspaceRow key={workspace.id} workspace={workspace} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
