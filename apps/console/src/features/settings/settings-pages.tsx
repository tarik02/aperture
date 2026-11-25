import { usePageCrumb } from "#/components/page-crumb.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { SettingsTable } from "#/features/settings/settings-table.tsx";
import { useSelectedWorkspaceId } from "#/features/workspace/selected-workspace.ts";
import { useWorkspacesQuery } from "#/features/workspace/workspace.queries.ts";

/** The settings of the whole instance, which every workspace, user and session starts from. */
export function InstanceSettingsPage() {
  return (
    <TablePage>
      <SettingsTable target={{ level: "instance" }} />
    </TablePage>
  );
}

/** The settings of one workspace, below the instance's. */
export function WorkspaceSettingsPage({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspacesQuery().data?.find((one) => one.id === workspaceId);
  usePageCrumb(workspace?.name);
  return (
    <TablePage>
      <SettingsTable target={{ level: "workspace", id: workspaceId }} />
    </TablePage>
  );
}

/**
 * What the user says for their own sessions, below the workspace that is selected: what
 * each setting comes to is what their sessions there have.
 */
export function AccountSettingsPage() {
  const workspaceId = useSelectedWorkspaceId();
  const joined = useWorkspacesQuery().data?.some(
    (one) => one.id === workspaceId && one.role !== null,
  );
  return (
    <TablePage>
      <SettingsTable
        target={{ level: "account", workspaceId: joined === true ? workspaceId : null }}
      />
    </TablePage>
  );
}
