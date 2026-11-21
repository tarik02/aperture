import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { SidebarMenuButton } from "@aperture-browser/ui/components/sidebar";
import { ChevronsUpDown, User, Users } from "lucide-react";
import { selectWorkspace } from "#/features/workspace/selected-workspace.ts";
import {
  useSelectedWorkspace,
  useWorkspacesQuery,
} from "#/features/workspace/workspace.queries.ts";

const PERSONAL = "personal";

/** Whose sessions and snapshots are shown: the account's own, or a workspace's. */
export function WorkspaceSwitcher() {
  const workspaces = useWorkspacesQuery();
  const selected = useSelectedWorkspace();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            data-console-workspace-switcher
            tooltip={selected?.name ?? "Personal"}
            className="aperture:border"
          />
        }
      >
        {selected === null ? <User /> : <Users />}
        <span data-sidebar-collapse-label className="aperture:flex-1 aperture:truncate">
          {selected?.name ?? "Personal"}
        </span>
        <ChevronsUpDown data-sidebar-collapse-label className="aperture:opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="aperture:min-w-52">
        <DropdownMenuRadioGroup
          value={selected?.id ?? PERSONAL}
          onValueChange={(value: string) => selectWorkspace(value === PERSONAL ? null : value)}
        >
          <DropdownMenuRadioItem value={PERSONAL}>Personal</DropdownMenuRadioItem>
          {workspaces.data?.map((workspace) => (
            <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>
              {workspace.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
