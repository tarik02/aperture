import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { useNavigate } from "@tanstack/react-router";
import { Camera, EllipsisVertical, ExternalLink, Link2, Pause, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import type { Session } from "#/features/session/session.queries.ts";
import { useSessionActionMutation } from "#/features/session/session.mutations.ts";
import { SaveSnapshotDialog } from "#/features/snapshot/save-snapshot-dialog.tsx";

/** What is done with one session. */
export function SessionActionsMenu({ session }: { session: Session }) {
  const navigate = useNavigate();
  const suspend = useSessionActionMutation("suspend");
  const resume = useSessionActionMutation("resume");
  const remove = useSessionActionMutation("delete");
  const [dialog, setDialog] = useState<"delete" | "snapshot" | null>(null);
  const placed = session.nodeId !== null;

  const copyLink = async () => {
    await navigator.clipboard.writeText(`${location.origin}/-/sessions/${session.id}`);
    toast.success("Link copied");
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size="icon-sm" variant="ghost" aria-label="Session actions" />}
        >
          <EllipsisVertical />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() =>
              navigate({ to: "/-/sessions/$sessionId", params: { sessionId: session.id } })
            }
          >
            <ExternalLink />
            Open
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyLink()}>
            <Link2 />
            Copy link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {session.desiredState === "suspended" ? (
            <DropdownMenuItem disabled={!placed} onClick={() => resume.mutate(session.id)}>
              <Play />
              Resume
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={!placed} onClick={() => suspend.mutate(session.id)}>
              <Pause />
              Suspend
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={!placed} onClick={() => setDialog("snapshot")}>
            <Camera />
            Save to snapshot
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={dialog === "delete"}
        title="Delete this session?"
        description="Its profile and files are removed. Snapshots taken of it stay."
        confirmLabel="Delete"
        variant="destructive"
        pending={remove.isPending}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
        onConfirm={() => remove.mutate(session.id, { onSettled: () => setDialog(null) })}
      />
      <SaveSnapshotDialog
        sessionId={session.id}
        open={dialog === "snapshot"}
        onOpenChange={(open) => setDialog(open ? "snapshot" : null)}
      />
    </>
  );
}
