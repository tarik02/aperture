import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { SidebarMenuButton } from "@aperture-browser/ui/components/sidebar";
import { ChevronsUpDown, Eye, User, Users } from "lucide-react";
import { showEveryWorkspace, selectWorkspace } from "#/features/workspace/selected-workspace.ts";
import {
  type Workspace,
  useSelectedWorkspace,
  useShownWorkspaces,
} from "#/features/workspace/workspace.queries.ts";

const PERSONAL = "personal";

function WorkspaceItem({ workspace }: { workspace: Workspace }) {
  return (
    <DropdownMenuRadioItem value={workspace.id} data-console-workspace-choice={workspace.name}>
      <span className="aperture:min-w-0 aperture:wrap-anywhere">{workspace.name}</span>
    </DropdownMenuRadioItem>
  );
}

/**
 * Whose sessions and snapshots are shown: the account's own, or a workspace's. An admin
 * may ask for the workspaces they are not in as well, which they only look at.
 */
export function WorkspaceSwitcher() {
  const { joined, others, offersEvery, showsEvery } = useShownWorkspaces();
  const selected = useSelectedWorkspace();
  const onlooks = selected !== null && selected.role === null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            data-console-workspace-switcher
            data-console-workspace-onlooked={onlooks ? "" : undefined}
            tooltip={onlooks ? `${selected.name} · read only` : (selected?.name ?? "Personal")}
            // What opens a menu is named after that, and is as tall under a finger as the rest.
            className="aperture:border aperture:pointer-coarse:min-h-10"
          />
        }
      >
        {selected === null ? <User /> : onlooks ? <Eye /> : <Users />}
        <span data-sidebar-collapse-label className="aperture:flex-1 aperture:truncate">
          {selected?.name ?? "Personal"}
        </span>
        {onlooks ? (
          <span
            data-sidebar-collapse-label
            className="aperture:text-xs aperture:text-muted-foreground"
          >
            Read only
          </span>
        ) : null}
        <ChevronsUpDown data-sidebar-collapse-label className="aperture:opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="aperture:max-w-[min(20rem,calc(100vw-1rem))] aperture:min-w-52"
      >
        <DropdownMenuRadioGroup
          value={selected?.id ?? PERSONAL}
          onValueChange={(value: string) => selectWorkspace(value === PERSONAL ? null : value)}
        >
          <DropdownMenuRadioItem value={PERSONAL}>Personal</DropdownMenuRadioItem>
          {joined.map((workspace) => (
            <WorkspaceItem key={workspace.id} workspace={workspace} />
          ))}
          {others.length > 0 ? (
            <DropdownMenuGroup data-console-workspace-others>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Not a member · read only</DropdownMenuLabel>
              {others.map((workspace) => (
                <WorkspaceItem key={workspace.id} workspace={workspace} />
              ))}
            </DropdownMenuGroup>
          ) : null}
        </DropdownMenuRadioGroup>
        {offersEvery ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              data-console-workspace-every
              checked={showsEvery}
              onCheckedChange={showEveryWorkspace}
            >
              Show all workspaces
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
