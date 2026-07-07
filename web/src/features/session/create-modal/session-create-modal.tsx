import { Dialog, DialogContent } from "#/components/ui/dialog.tsx";
import type { CreateSessionResponse } from "#/lib/api/schemas.ts";
import { SessionForm } from "#/features/session/form/session-form.tsx";
import { useSessionCreateModalStore } from "#/features/session/create-modal/session-create-modal.store.ts";

type SessionCreateModalProps = {
  onCreated?: (result: CreateSessionResponse) => void;
};

export function SessionCreateModal({ onCreated }: SessionCreateModalProps) {
  const open = useSessionCreateModalStore((state) => state.open);
  const setOpen = useSessionCreateModalStore((state) => state.setOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl">
        <SessionForm onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}
