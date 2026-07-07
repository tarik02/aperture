import { Dialog, DialogContent } from "#/components/ui/dialog.tsx";
import { SessionPromoteForm } from "#/features/session/promote-form/session-promote-form.tsx";
import { useSessionPromoteModalStore } from "#/features/session/promote-modal/session-promote-modal.store.ts";

export function SessionPromoteModal() {
  const open = useSessionPromoteModalStore((state) => state.open);
  const setOpen = useSessionPromoteModalStore((state) => state.setOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl">
        <SessionPromoteForm />
      </DialogContent>
    </Dialog>
  );
}
