import { DialogBody, DialogHeader, DialogTitle } from "@aperture-browser/ui/components/dialog";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { SettingsTable } from "#/features/settings/settings-table.tsx";

/** What one session's settings come to, and what is said of them for it alone. */
export function SessionSettingsDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <FreshDialog open={open} onOpenChange={onOpenChange} className="aperture:sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Session settings</DialogTitle>
      </DialogHeader>
      <DialogBody height="min(28rem, 70dvh)">
        <SettingsTable target={{ level: "session", id: sessionId }} />
      </DialogBody>
    </FreshDialog>
  );
}
