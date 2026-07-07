import { Dialog, DialogContent } from "#/components/ui/dialog.tsx";
import { TagForm } from "#/features/tag/form/tag-form.tsx";
import { useTagFormStore } from "#/features/tag/form/tag-form.store.ts";
import { useTagEditModalStore } from "#/features/tag/edit-modal/tag-edit-modal.store.ts";

type TagEditModalProps = {
  resourceKey: string | null;
  title: string;
  onSave: (tags: Record<string, string>) => Promise<void>;
};

export function TagEditModal({ resourceKey, title, onSave }: TagEditModalProps) {
  const modalOpen = useTagEditModalStore((state) => state.open);
  const setOpen = useTagEditModalStore((state) => state.setOpen);
  const activeResourceKey = useTagFormStore((state) => state.formData.resourceKey);
  const open = modalOpen && resourceKey !== null && activeResourceKey === resourceKey;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl">
        <TagForm title={title} onSave={onSave} />
      </DialogContent>
    </Dialog>
  );
}
