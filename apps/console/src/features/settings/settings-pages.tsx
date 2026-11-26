import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { usePageCrumb } from "#/components/page-crumb.tsx";
import {
  SaveBar,
  SettingsSections,
  useSettingsEditor,
} from "#/features/settings/settings-editor.tsx";
import type { SettingsTarget } from "#/features/settings/settings.queries.ts";
import { useSelectedWorkspaceId } from "#/features/workspace/selected-workspace.ts";
import { useWorkspacesQuery } from "#/features/workspace/workspace.queries.ts";

/** A level's settings down the middle of the page, and what saves them at its foot. */
function SettingsPage({ target }: { target: SettingsTarget }) {
  const editor = useSettingsEditor(target);
  return (
    <div className="aperture:relative aperture:h-full aperture:min-h-0">
      <ScrollArea className="aperture:h-full" viewportClassName="aperture:p-4 aperture:max-sm:p-3">
        {/* Room at the foot for what saves, so it covers nothing of the last row. */}
        <div className="aperture:mx-auto aperture:w-full aperture:max-w-240 aperture:pb-20">
          <SettingsSections editor={editor} />
        </div>
      </ScrollArea>
      <SaveBar editor={editor} />
    </div>
  );
}

/** The settings of the whole instance, which every workspace, user and session starts from. */
export function InstanceSettingsPage() {
  return <SettingsPage target={{ level: "instance" }} />;
}

/** The settings of one workspace, below the instance's. */
export function WorkspaceSettingsPage({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspacesQuery().data?.find((one) => one.id === workspaceId);
  usePageCrumb(workspace?.name);
  return <SettingsPage key={workspaceId} target={{ level: "workspace", id: workspaceId }} />;
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
  const inWorkspace = joined === true ? workspaceId : null;
  return (
    <SettingsPage key={inWorkspace ?? ""} target={{ level: "account", workspaceId: inWorkspace }} />
  );
}
