import { Dialog, DialogContent } from "#/components/ui/dialog.tsx";
import { TokenCreateForm } from "#/features/token/create-form/token-create-form.tsx";
import { useTokenCreateModalStore } from "#/features/token/create-modal/token-create-modal.store.ts";

export function TokenCreateModal() {
  const open = useTokenCreateModalStore((state) => state.open);
  const setOpen = useTokenCreateModalStore((state) => state.setOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <TokenCreateForm />
      </DialogContent>
    </Dialog>
  );
}
