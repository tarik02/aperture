import { Dialog, DialogContent } from "#/components/ui/dialog.tsx";
import { TokenForm } from "#/features/token/form/token-form.tsx";
import { useTokenFormStore } from "#/features/token/form/token-form.store.ts";
import { useTokenAuthModalStore } from "#/features/token/auth-modal/token-auth-modal.store.ts";

type WelcomeTokenAuthModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function TokenAuthModal() {
  const open = useTokenAuthModalStore((state) => state.open);
  const setOpen = useTokenAuthModalStore((state) => state.setOpen);
  const closeModal = useTokenAuthModalStore((state) => state.closeModal);
  const mode = useTokenFormStore((state) => state.mode);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <TokenForm mode={mode} onDone={closeModal} />
      </DialogContent>
    </Dialog>
  );
}

export function WelcomeTokenAuthModal({ open, onOpenChange }: WelcomeTokenAuthModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <TokenForm mode="welcome" dismissible={false} onDone={() => undefined} />
      </DialogContent>
    </Dialog>
  );
}
