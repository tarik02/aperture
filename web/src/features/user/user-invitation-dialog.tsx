import { CopyField } from "#/components/resources/copy-field.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { formatTimestamp } from "#/lib/format.ts";
import type { UserInvitation } from "#/lib/api/schemas.ts";

export type UserPasswordLink = {
  kind: "setup" | "reset";
  invitation: UserInvitation;
};

type UserInvitationDialogProps = {
  open: boolean;
  link: UserPasswordLink | null;
  userName: string;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
};

export function UserInvitationDialog({
  open,
  link,
  userName,
  onOpenChange,
  onOpenChangeComplete,
}: UserInvitationDialogProps) {
  const setupUrl = link
    ? `${window.location.origin}/invite#${new URLSearchParams({ token: link.invitation.token })}`
    : "";
  const reset = link?.kind === "reset";
  const linkLabel = reset ? "Reset link" : "Setup link";

  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{reset ? "Reset password link" : "Password setup link"}</DialogTitle>
          <DialogDescription>
            Share this link with {userName}. It works once and lets them choose a new password.
          </DialogDescription>
        </DialogHeader>
        <CopyField value={setupUrl} label={linkLabel} />
        <p className="text-xs text-muted-foreground">
          Expires {formatTimestamp(link?.invitation.expiresAt)}. Creating another link replaces this
          one.
        </p>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
