import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@aperture-browser/ui/components/tabs";
import { type ReactNode, useState } from "react";
import { usePageCrumb } from "#/components/page-crumb.tsx";
import {
  SaveBar,
  SectionsSkeleton,
  SettingsSections,
  useSettingsEditor,
} from "#/features/settings/settings-editor.tsx";
import type { SettingsTarget } from "#/features/settings/settings.queries.ts";
import { useUnsavedGuard } from "#/features/settings/unsaved-guard.tsx";
import { useSelectedWorkspaceId } from "#/features/workspace/selected-workspace.ts";
import { useWorkspacesQuery } from "#/features/workspace/workspace.queries.ts";

/** Down the middle of the page, with room at its foot for what saves. */
function SettingsFrame({ children, bar }: { children: ReactNode; bar?: ReactNode }) {
  return (
    <div className="aperture:relative aperture:h-full aperture:min-h-0">
      <ScrollArea className="aperture:h-full" viewportClassName="aperture:p-4 aperture:max-sm:p-3">
        {/* Room at the foot for what saves, so it covers nothing of the last row. */}
        <div className="aperture:mx-auto aperture:flex aperture:w-full aperture:max-w-240 aperture:flex-col aperture:gap-4 aperture:pb-20">
          {children}
        </div>
      </ScrollArea>
      {bar}
    </div>
  );
}

/**
 * A level's settings, and what saves them at its foot. What was changed and not saved is
 * not left without being asked first; `head` is given what asks, for what it changes.
 */
function SettingsPage({
  target,
  ofWorkspace = false,
  head,
}: {
  target: SettingsTarget;
  /** Whether another workspace selected is another level shown. */
  ofWorkspace?: boolean;
  head?: (ask: (go: () => void) => void) => ReactNode;
}) {
  const editor = useSettingsEditor(target);
  // What is being saved is saved, whether or not the page stays.
  const guard = useUnsavedGuard(editor.count > 0 && !editor.saving, { ofWorkspace });
  return (
    <SettingsFrame bar={<SaveBar editor={editor} />}>
      {head?.(guard.ask)}
      <SettingsSections editor={editor} />
      {guard.dialog}
    </SettingsFrame>
  );
}

/** The settings of the whole instance, which every workspace, user and session starts from. */
export function InstanceSettingsPage() {
  return <SettingsPage target={{ level: "instance" }} />;
}

/** The settings of one workspace, below the instance's. */
export function WorkspaceSettingsPage({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspacesQuery().data?.find((one) => one.id === workspaceId);
  usePageCrumb(workspace === undefined ? undefined : [workspace.name, "Settings"]);
  return <SettingsPage key={workspaceId} target={{ level: "workspace", id: workspaceId }} />;
}

/**
 * What the user says for their own sessions: everywhere, or in the workspace that is
 * selected, where what each setting comes to is what their sessions there have. What an
 * admin set for them holds.
 */
export function AccountSettingsPage() {
  const workspaces = useWorkspacesQuery();
  const workspaceId = useSelectedWorkspaceId();
  const [everywhere, setEverywhere] = useState(false);
  // Which level is shown is known once the workspaces are.
  if (workspaces.isPending) {
    return (
      <SettingsFrame>
        <SectionsSkeleton />
      </SettingsFrame>
    );
  }
  const workspace = workspaces.data?.find((one) => one.id === workspaceId && one.role !== null);
  const member = workspace !== undefined && !everywhere;
  const head = (ask: (go: () => void) => void) =>
    workspace === undefined ? (
      <p
        data-console-settings-own="account"
        className="aperture:px-1 aperture:text-sm aperture:font-medium"
      >
        Your settings everywhere
      </p>
    ) : (
      <Tabs
        value={member ? "member" : "account"}
        onValueChange={(next: string) => ask(() => setEverywhere(next === "account"))}
      >
        <TabsList data-console-settings-own={member ? "member" : "account"}>
          <TabsTrigger value="member" data-console-settings-level="member">
            In {workspace.name}
          </TabsTrigger>
          <TabsTrigger value="account" data-console-settings-level="account">
            Everywhere
          </TabsTrigger>
        </TabsList>
      </Tabs>
    );
  return member ? (
    <SettingsPage
      key={workspace.id}
      target={{ level: "member", workspaceId: workspace.id, accountId: null }}
      ofWorkspace
      head={head}
    />
  ) : (
    <SettingsPage
      key=""
      target={{ level: "account", accountId: null }}
      ofWorkspace={workspace === undefined}
      head={head}
    />
  );
}
