import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { type ComponentProps, useEffect, useRef } from "react";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  variant?: ComponentProps<typeof Button>["variant"];
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  variant = "default",
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  // Once is enough: a second press comes before what the first did is known here, so
  // nothing that is told later holds it back. It is taken again once that is done with.
  const confirmed = useRef(false);
  useEffect(() => {
    if (!pending) {
      confirmed.current = false;
    }
  }, [pending, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/* Not again while it is done, nor while the dialog closes. */}
          <Button
            type="button"
            variant={variant}
            pending={pending}
            disabled={!open}
            onClick={() => {
              if (pending || !open || confirmed.current) {
                return;
              }
              confirmed.current = true;
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
