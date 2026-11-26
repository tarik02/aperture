import { Button } from "@aperture-browser/ui/components/button";
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

/** How much was changed and not saved, and whether it is being saved now. */
type Unsaved = { readonly count: number; readonly saving: boolean };

/**
 * A level's settings over what it was opened from, edited where they are and saved at its
 * foot. What is changed and not saved is not closed away without being asked first, and
 * nothing closes while it is being saved.
 */
export function SettingsDialog({ target, title, open, onOpenChange }: SettingsDialogProps) {
  const unsaved = useRef<Unsaved>({ count: 0, saving: false });
  const [asking, setAsking] = useState(false);
  const close = (next: boolean) => {
    if (!next && unsaved.current.saving) {
      return;
    }
    if (!next && unsaved.current.count > 0) {
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
        onUnsaved={(now) => {
          unsaved.current = now;
        }}
        onClose={() => close(false)}
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
          unsaved.current = { count: 0, saving: false };
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
  onClose,
}: {
  target: SettingsTarget;
  title: string;
  onUnsaved: (now: Unsaved) => void;
  onClose: () => void;
}) {
  const editor = useSettingsEditor(target);
  const writes = editor.views.some((setting) => setting.changeable);
  useEffect(
    () => onUnsaved({ count: editor.count, saving: editor.saving }),
    [onUnsaved, editor.count, editor.saving],
  );
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody height="min(40rem, 75dvh)">
        <SettingsSections editor={editor} />
      </DialogBody>
      {/* Where there is nothing to save, nothing saves, once that is known: the foot, as tall, closes. */}
      <DialogFooter
        data-console-settings-footer
        className="aperture:items-center aperture:sm:justify-between"
      >
        {writes || !editor.settings.isSuccess ? (
          <SaveActions editor={editor} />
        ) : (
          <>
            <span />
            <Button size="sm" variant="outline" data-console-settings-close onClick={onClose}>
              Close
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
