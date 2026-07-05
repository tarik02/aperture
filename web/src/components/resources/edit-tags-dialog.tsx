import { useEffect } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { TagEditor, entriesToTags, tagsToEntries } from "#/components/resources/tag-editor.tsx";
import { useFormDraftStore } from "#/stores/form-drafts.ts";

type EditTagsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceKey: string | null;
  title: string;
  initialTags?: Record<string, string>;
  onSave: (tags: Record<string, string>) => Promise<void>;
};

export function EditTagsDialog({
  open,
  onOpenChange,
  resourceKey,
  title,
  initialTags,
  onSave,
}: EditTagsDialogProps) {
  const entries = useFormDraftStore((state) => state.editTags.entries);
  const submitting = useFormDraftStore((state) => state.editTags.submitting);
  const setEditTags = useFormDraftStore((state) => state.setEditTags);
  const resetEditTags = useFormDraftStore((state) => state.resetEditTags);

  useEffect(() => {
    if (open && resourceKey) {
      resetEditTags(resourceKey, tagsToEntries(initialTags ?? {}));
    }
  }, [open, resourceKey, initialTags, resetEditTags]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setEditTags({ submitting: true });
    try {
      await onSave(entriesToTags(entries));
      onOpenChange(false);
    } finally {
      setEditTags({ submitting: false });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <TagEditor
              entries={entries}
              onChange={(nextEntries) => setEditTags({ entries: nextEntries })}
              disabled={submitting}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
