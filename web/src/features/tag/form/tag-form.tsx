import { Button } from "@aperture/ui/components/button";
import { DialogFooter, DialogHeader, DialogTitle } from "@aperture/ui/components/dialog";
import { TagEditor, entriesToTags } from "@aperture/ui/components/tag-editor";
import { useTagEditModalStore } from "#/features/tag/edit-modal/tag-edit-modal.store.ts";
import { useTagFormStore } from "#/features/tag/form/tag-form.store.ts";

type TagFormProps = {
  title: string;
  onSave: (tags: Record<string, string>) => Promise<void>;
};

export function TagForm({ title, onSave }: TagFormProps) {
  const { entries, submitting } = useTagFormStore((state) => state.formData);
  const setFormData = useTagFormStore((state) => state.setFormData);
  const closeModal = useTagEditModalStore((state) => state.closeModal);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormData({ submitting: true });
    try {
      await onSave(entriesToTags(entries));
      closeModal();
    } finally {
      setFormData({ submitting: false });
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <div className="py-2">
        <TagEditor
          entries={entries}
          onChange={(nextEntries) => setFormData({ entries: nextEntries })}
          disabled={submitting}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={closeModal} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
