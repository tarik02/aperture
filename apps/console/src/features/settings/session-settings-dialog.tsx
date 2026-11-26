import { SettingsDialog } from "#/features/settings/settings-dialog.tsx";

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
    <SettingsDialog
      target={{ level: "session", id: sessionId }}
      title="Session settings"
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
