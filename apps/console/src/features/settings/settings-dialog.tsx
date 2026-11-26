import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import {
  SaveActions,
  SettingsSections,
  useSettingsEditor,
} from "#/features/settings/settings-editor.tsx";
import type { SettingsTarget } from "#/features/settings/settings.queries.ts";

type SettingsDialogProps = {
  target: SettingsTarget;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * A level's settings over what it was opened from, edited where they are and saved at its
 * foot. What is changed and not saved is not closed away without being asked first.
 */
export function SettingsDialog({ target, title, open, onOpenChange }: SettingsDialogProps) {
  const unsaved = useRef(0);
  const [asking, setAsking] = useState(false);
  const close = (next: boolean) => {
    if (!next && unsaved.current > 0) {
      setAsking(true);
      return;
    }
    onOpenChange(next);
  };

  return (
    <FreshDialog open={open} onOpenChange={close} className="aperture:sm:max-w-240">
      <Settings
        target={target}
        title={title}
        onUnsaved={(count) => {
          unsaved.current = count;
        }}
      />
      <ConfirmDialog
        open={asking}
        title="Discard unsaved changes?"
        description="What was changed here and not saved is forgotten."
        confirmLabel="Discard changes"
        variant="destructive"
        onOpenChange={setAsking}
        onConfirm={() => {
          setAsking(false);
          unsaved.current = 0;
          onOpenChange(false);
        }}
      />
    </FreshDialog>
  );
}

function Settings({
  target,
  title,
  onUnsaved,
}: {
  target: SettingsTarget;
  title: string;
  onUnsaved: (count: number) => void;
}) {
  const editor = useSettingsEditor(target);
  const writes = editor.views.some((setting) => setting.changeable);
  useEffect(() => onUnsaved(editor.count), [onUnsaved, editor.count]);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody height="min(40rem, 75dvh)">
        <SettingsSections editor={editor} />
      </DialogBody>
      {/* Where there is nothing to save, nothing saves: once that is known. */}
      {writes || !editor.settings.isSuccess ? (
        <DialogFooter
          data-console-settings-footer
          className="aperture:items-center aperture:sm:justify-between"
        >
          <SaveActions editor={editor} />
        </DialogFooter>
      ) : null}
    </>
  );
}
