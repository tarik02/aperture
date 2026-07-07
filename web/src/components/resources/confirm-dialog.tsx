import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog.tsx";
import type { Button } from "#/components/ui/button.tsx";
import type { ComponentProps } from "react";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  variant?: ComponentProps<typeof Button>["variant"];
  onOpenChange: (open: boolean) => void;
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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            type="button"
            variant={variant}
            disabled={pending}
            onClick={() => void handleConfirm()}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
