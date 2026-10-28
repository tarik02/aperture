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

export function SessionActionsMenu({ trigger, align = "end", ...props }: SessionActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align={align} className="aperture:min-w-52">
        <SessionActionItems {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Actions a surrounding menu already offers some other way. */
export type SessionActionKey = "details" | "viewer-link";

type SessionActionItemsProps = Omit<SessionActionsMenuProps, "trigger" | "align"> & {
  exclude?: ReadonlySet<SessionActionKey>;
  /**
   * Which part to render. A host menu with its own sections places the parts itself: opening
   * and settings, sharing items for its share submenu, and the closing part that changes or
   * removes the session.
   */
  part?: "all" | "primary" | "share" | "closing";
};

/** The items of the session menu, for embedding in another menu. */
export function SessionActionItems({ part = "all", ...props }: SessionActionItemsProps) {
  if (part === "primary") {
    return <PrimaryItems {...props} />;
  }
  if (part === "share") {
    return <ShareItems {...props} />;
  }
  if (part === "closing") {
    return <ClosingItems {...props} />;
  }
  return (
    <>
      <PrimaryItems {...props} />
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Link2 />
            Share and connect
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="aperture:min-w-52">
            <ShareItems {...props} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuGroup>
      {props.permissions.canWrite ? (
        <>
          <DropdownMenuSeparator />
          <ClosingItems {...props} />
        </>
      ) : null}
    </>
  );
}

function PrimaryItems({ session, actions, permissions, onOpen, exclude }: SessionActionItemsProps) {
  const { canWrite } = permissions;
  const shown = (key: SessionActionKey) => exclude?.has(key) !== true;
  const proxyEditable =
    session.status === "creating" || session.status === "running" || session.status === "suspended";

  return (
    <DropdownMenuGroup>
      {onOpen && isOpenable(session.status) ? (
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
      {canWrite && proxyEditable ? (
        <DropdownMenuItem onClick={() => actions.editProxy(session)}>
          <Network />
          Proxy
        </DropdownMenuItem>
      ) : null}
      {shown("details") ? (
        <DropdownMenuItem onClick={() => actions.details(session)}>
          <Info />
          Details
        </DropdownMenuItem>
      ) : null}
    </DropdownMenuGroup>
  );
}

function ShareItems({
  session,
  actions,
  permissions,
  onOpenCdp,
  exclude,
}: SessionActionItemsProps) {
  const { canWrite } = permissions;
  const openable = isOpenable(session.status);
  return (
    <DropdownMenuGroup>
      <DropdownMenuItem onClick={() => actions.copyLink(session)}>
        <Link2 />
        Copy link
      </DropdownMenuItem>
      {exclude?.has("viewer-link") !== true && canWrite && openable ? (
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
    </DropdownMenuGroup>
  );
}

/** Edits that change the session's state, ending with deleting it. Needs write access. */
function ClosingItems({ session, actions, permissions }: SessionActionItemsProps) {
  if (!permissions.canWrite) {
    return null;
  }
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => actions.details(session, "tags")}>
          <Tags />
          Edit tags
        </DropdownMenuItem>
        {session.status === "running" ? (
          <DropdownMenuItem onClick={() => actions.suspend(session)}>
            <Pause />
            Suspend
          </DropdownMenuItem>
        ) : null}
        {permissions.canSaveSnapshots && isSaveable(session.status) ? (
          <DropdownMenuItem onClick={() => actions.saveToSnapshot(session)}>
            <Camera />
            Save to snapshot
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={() => actions.deleteSession(session)}>
        <Trash2 />
        Delete
      </DropdownMenuItem>
    </>
  );
}
