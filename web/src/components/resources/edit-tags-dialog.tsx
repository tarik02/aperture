import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import {
  TagEditor,
  entriesToTags,
  tagsToEntries,
  type TagEntry,
} from "#/components/resources/tag-editor.tsx";

type EditTagsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initialTags?: Record<string, string>;
  onSave: (tags: Record<string, string>) => Promise<void>;
};

export function EditTagsDialog({
  open,
  onOpenChange,
  title,
  initialTags,
  onSave,
}: EditTagsDialogProps) {
  const [entries, setEntries] = useState<TagEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setEntries(tagsToEntries(initialTags ?? {}));
    }
  }, [open, initialTags]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await onSave(entriesToTags(entries));
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <TagEditor entries={entries} onChange={setEntries} disabled={submitting} />
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
