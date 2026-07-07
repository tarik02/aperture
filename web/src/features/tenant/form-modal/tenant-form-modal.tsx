import { Dialog, DialogContent } from "#/components/ui/dialog.tsx";
import { TenantForm } from "#/features/tenant/form/tenant-form.tsx";
import { useTenantFormStore } from "#/features/tenant/form/tenant-form.store.ts";
import { useTenantFormModalStore } from "#/features/tenant/form-modal/tenant-form-modal.store.ts";

export function TenantFormModal() {
  const open = useTenantFormModalStore((state) => state.open);
  const setOpen = useTenantFormModalStore((state) => state.setOpen);
  const closeModal = useTenantFormModalStore((state) => state.closeModal);
  const mode = useTenantFormStore((state) => state.mode);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <TenantForm mode={mode} onDone={closeModal} />
      </DialogContent>
    </Dialog>
  );
}
