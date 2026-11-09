import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Button } from "@aperture-browser/ui/components/button";
import { useEffectCallback } from "@aperture-browser/session-react";
import * as Effect from "effect/Effect";
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
  const handleConfirm = useEffectCallback(
    () =>
      Effect.tryPromise(async () => onConfirm()).pipe(
        Effect.andThen(Effect.sync(() => onOpenChange(false))),
        Effect.catch((error) => Effect.logWarning("Confirm action failed", error)),
      ),
    [onConfirm, onOpenChange],
  );

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
            onClick={() => handleConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
