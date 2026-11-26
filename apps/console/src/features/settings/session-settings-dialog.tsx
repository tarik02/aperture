import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import {
  SaveActions,
  SettingsSections,
  useSettingsEditor,
} from "#/features/settings/settings-editor.tsx";

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
      <SessionSettings sessionId={sessionId} />
    </FreshDialog>
  );
}

function SessionSettings({ sessionId }: { sessionId: string }) {
  const editor = useSettingsEditor({ level: "session", id: sessionId });
  const writes = editor.views.some((setting) => setting.changeable);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Session settings</DialogTitle>
      </DialogHeader>
      <DialogBody height="min(34rem, 70dvh)">
        <SettingsSections editor={editor} />
      </DialogBody>
      {/* Where there is nothing to save, nothing saves: once that is known. */}
      {writes || !editor.settings.isSuccess ? (
        <DialogFooter className="aperture:items-center aperture:sm:justify-between">
          <SaveActions editor={editor} />
        </DialogFooter>
      ) : null}
    </>
  );
}
