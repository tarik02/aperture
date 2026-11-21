import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@aperture-browser/ui/components/context-menu";
import { useNavigate } from "@tanstack/react-router";
import {
  AppWindow,
  Camera,
  EllipsisVertical,
  ExternalLink,
  Info,
  Link2,
  type LucideIcon,
  Pause,
  Play,
  Plug,
  Share2,
  Tags,
  Trash2,
  Waypoints,
} from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { DescribeDialog } from "#/components/describe-dialog.tsx";
import { SessionMcpDialog } from "#/features/mcp/session-mcp-dialog.tsx";
import { SessionProxyDialog } from "#/features/proxy/session-proxy-dialog.tsx";
import { SessionDetailsDialog } from "#/features/session/session-details-dialog.tsx";
import { SessionShareDialog } from "#/features/share/session-share-dialog.tsx";
import type { Session } from "#/features/session/session.queries.ts";
import {
  useDescribeSessionMutation,
  useSessionActionMutation,
} from "#/features/session/session.mutations.ts";
import { SaveSnapshotDialog } from "#/features/snapshot/save-snapshot-dialog.tsx";

/** One thing done with a session, as a menu of either kind offers it. */
export interface SessionAction {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  /** A line before it, where another kind of thing begins. */
  readonly parted?: boolean;
}

/**
 * What is done with one session, for its menus: the button's and the one a right click
 * opens offer the same, and share the dialogs those lead to.
 */
export function useSessionActions(session: Session, onDeleted?: () => void) {
  const navigate = useNavigate();
  const suspend = useSessionActionMutation("suspend");
  const resume = useSessionActionMutation("resume");
  const remove = useSessionActionMutation("delete");
  const describe = useDescribeSessionMutation();
  const [dialog, setDialog] = useState<
    "delete" | "snapshot" | "describe" | "proxy" | "details" | "mcp" | "share" | null
  >(null);
  const placed = session.nodeId !== null;

  const copyLink = async () => {
    await navigator.clipboard.writeText(`${location.origin}/-/sessions/${session.id}`);
    toast.success("Link copied");
  };

  const actions: ReadonlyArray<SessionAction> = [
    {
      key: "open",
      label: "Open",
      icon: ExternalLink,
      onSelect: () =>
        void navigate({ to: "/-/sessions/$sessionId", params: { sessionId: session.id } }),
    },
    { key: "copy", label: "Copy link", icon: Link2, onSelect: () => void copyLink() },
    { key: "share", label: "Share", icon: Share2, onSelect: () => setDialog("share") },
    { key: "details", label: "Details", icon: Info, onSelect: () => setDialog("details") },
    { key: "describe", label: "Edit details", icon: Tags, onSelect: () => setDialog("describe") },
    {
      key: "proxy",
      label: "Edit routing",
      icon: Waypoints,
      disabled: !placed,
      onSelect: () => setDialog("proxy"),
    },
    {
      key: "mcp",
      label: "Connect MCP",
      icon: Plug,
      disabled: !placed,
      onSelect: () => setDialog("mcp"),
    },
    session.desiredState === "suspended"
      ? {
          key: "resume",
          label: "Resume",
          icon: Play,
          disabled: !placed,
          parted: true,
          onSelect: () => resume.mutate(session.id),
        }
      : {
          key: "suspend",
          label: "Suspend",
          icon: Pause,
          disabled: !placed,
          parted: true,
          onSelect: () => suspend.mutate(session.id),
        },
    {
      key: "snapshot",
      label: "Save to snapshot",
      icon: Camera,
      disabled: !placed,
      onSelect: () => setDialog("snapshot"),
    },
    {
      key: "delete",
      label: "Delete",
      icon: Trash2,
      destructive: true,
      parted: true,
      onSelect: () => setDialog("delete"),
    },
  ];

  const dialogs = (
    <>
      <ConfirmDialog
        open={dialog === "delete"}
        title="Delete this session?"
        description="Its profile and files are removed. Snapshots taken of it stay."
        confirmLabel="Delete"
        variant="destructive"
        pending={remove.isPending}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
        onConfirm={() =>
          remove.mutate(session.id, { onSettled: () => setDialog(null), onSuccess: onDeleted })
        }
      />
      <DescribeDialog
        title="Edit session"
        nameLabel="Label"
        initial={{ name: session.label, tags: session.tags }}
        open={dialog === "describe"}
        onOpenChange={(open) => setDialog(open ? "describe" : null)}
        onSubmit={(said) =>
          describe.mutateAsync({ id: session.id, label: said.name, tags: said.tags })
        }
      />
      <SessionDetailsDialog
        session={session}
        open={dialog === "details"}
        onOpenChange={(open) => setDialog(open ? "details" : null)}
      />
      <SessionProxyDialog
        sessionId={session.id}
        open={dialog === "proxy"}
        onOpenChange={(open) => setDialog(open ? "proxy" : null)}
      />
      <SessionMcpDialog
        session={session}
        open={dialog === "mcp"}
        onOpenChange={(open) => setDialog(open ? "mcp" : null)}
      />
      <SessionShareDialog
        session={session}
        open={dialog === "share"}
        onOpenChange={(open) => setDialog(open ? "share" : null)}
      />
      <SaveSnapshotDialog
        session={session}
        open={dialog === "snapshot"}
        onOpenChange={(open) => setDialog(open ? "snapshot" : null)}
      />
    </>
  );

  return { actions, dialogs };
}

const MENU = "aperture:w-auto aperture:min-w-44 aperture:whitespace-nowrap";

/** The session's actions behind a button. */
export function SessionActionsMenu({ actions }: { actions: ReadonlyArray<SessionAction> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label="Session actions" />}
      >
        <EllipsisVertical />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={MENU}>
        <SessionActionItems actions={actions} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionActionItems({ actions }: { actions: ReadonlyArray<SessionAction> }) {
  return actions.map((action) => (
    <Fragment key={action.key}>
      {action.parted === true ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem
        disabled={action.disabled === true}
        variant={action.destructive === true ? "destructive" : "default"}
        onClick={action.onSelect}
      >
        <action.icon />
        {action.label}
      </DropdownMenuItem>
    </Fragment>
  ));
}

/** The same actions as a menu within another menu, for where the session is open already. */
export function SessionActionsSubmenu({ actions }: { actions: ReadonlyArray<SessionAction> }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-console-session-submenu>
        <AppWindow />
        Session
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={MENU}>
        <SessionActionItems actions={actions.filter((action) => action.key !== "open")} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** The same actions where a right click was, on whatever it wraps. */
export function SessionContextMenu({
  actions,
  children,
}: {
  actions: ReadonlyArray<SessionAction>;
  children: React.ReactElement;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent data-console-session-context className={MENU}>
        {actions.map((action) => (
          <Fragment key={action.key}>
            {action.parted === true ? <ContextMenuSeparator /> : null}
            <ContextMenuItem
              disabled={action.disabled === true}
              variant={action.destructive === true ? "destructive" : "default"}
              onClick={action.onSelect}
            >
              <action.icon />
              {action.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
