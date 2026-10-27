import type { Session } from "@aperture-browser/api-client";
import {
  AppWindow,
  Camera,
  Cable,
  Copy,
  Info,
  KeyRound,
  Link2,
  Network,
  Pause,
  PlugZap,
  RotateCcw,
  Tags,
  Trash2,
} from "lucide-react";
import type { ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import type { SessionActions, SessionPermissions } from "#/features/session/session-dialogs.tsx";
import { isOpenable, isReopenable, isSaveable } from "#/features/session/session-display.ts";

type SessionActionsMenuProps = {
  session: Session;
  actions: SessionActions;
  permissions: SessionPermissions;
  trigger: ReactElement;
  /** Opens the session; omitted where the session is already shown. */
  onOpen?: () => void;
  onOpenCdp?: () => void;
  align?: "start" | "end";
};

export function SessionActionsMenu({
  session,
  actions,
  permissions,
  trigger,
  onOpen,
  onOpenCdp,
  align = "end",
}: SessionActionsMenuProps) {
  const { canWrite, canSaveSnapshots } = permissions;
  const openable = isOpenable(session.status);
  const proxyEditable =
    session.status === "creating" || session.status === "running" || session.status === "suspended";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align={align} className="aperture:min-w-52">
        <DropdownMenuGroup>
          {onOpen && openable ? (
            <DropdownMenuItem onClick={onOpen}>
              <AppWindow />
              Open
            </DropdownMenuItem>
          ) : null}
          {canWrite && isReopenable(session.status) ? (
            <DropdownMenuItem onClick={() => actions.reopen(session)}>
              <RotateCcw />
              Reopen
            </DropdownMenuItem>
          ) : null}
          {canWrite && session.status === "running" ? (
            <DropdownMenuItem onClick={() => actions.suspend(session)}>
              <Pause />
              Suspend
            </DropdownMenuItem>
          ) : null}
          {canSaveSnapshots && isSaveable(session.status) ? (
            <DropdownMenuItem onClick={() => actions.saveToSnapshot(session)}>
              <Camera />
              Save to snapshot
            </DropdownMenuItem>
          ) : null}
          {canWrite && proxyEditable ? (
            <DropdownMenuItem onClick={() => actions.editProxy(session)}>
              <Network />
              Proxy
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => actions.details(session)}>
            <Info />
            Details
          </DropdownMenuItem>
          {canWrite ? (
            <DropdownMenuItem onClick={() => actions.details(session, "tags")}>
              <Tags />
              Edit tags
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Link2 />
              Share and connect
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="aperture:min-w-52">
              <DropdownMenuItem onClick={() => actions.copyLink(session)}>
                <Link2 />
                Copy link
              </DropdownMenuItem>
              {canWrite && openable ? (
                <DropdownMenuItem onClick={() => actions.copyShareUrl(session)}>
                  <Copy />
                  Copy viewer link
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => actions.connectMcp(session)}>
                <PlugZap />
                Connect an MCP client
              </DropdownMenuItem>
              {onOpenCdp && openable ? (
                <DropdownMenuItem onClick={onOpenCdp}>
                  <Cable />
                  Open without WebRTC
                </DropdownMenuItem>
              ) : null}
              {canWrite && openable ? (
                <DropdownMenuItem onClick={() => actions.rotateToken(session)}>
                  <KeyRound />
                  Rotate session token
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        {canWrite ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => actions.deleteSession(session)}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
