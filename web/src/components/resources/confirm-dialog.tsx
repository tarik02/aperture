import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture/ui/components/dialog";
import { Button } from "@aperture/ui/components/button";
import type { ComponentProps } from "react";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  variant?: ComponentProps<typeof Button>["variant"];
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  onConfirm: () => Promise<void> | void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  variant = "default",
  onOpenChange,
  onOpenChangeComplete,
  onConfirm,
}: ConfirmDialogProps) {
  async function handleConfirm() {
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (error) {
      console.warn("Confirm action failed", error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={variant}
            disabled={pending}
            onClick={() => void handleConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
