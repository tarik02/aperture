import { Button } from "@aperture-browser/ui/components/button";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { useForm, useStore } from "@tanstack/react-form";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { TextField } from "#/components/text-field.tsx";
import { required } from "#/lib/validation.ts";

type NameDialogProps = {
  title: string;
  description?: string;
  /** The name there is already, where one is changed. */
  initial?: string;
  /** What the button that takes the name says. */
  submitLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Makes what is named; the dialog closes once it is made, and stays when it is not. */
  onSubmit: (name: string) => Promise<unknown>;
};

/** Makes something that needs nothing but a name. */
export function NameDialog({ open, onOpenChange, ...form }: NameDialogProps) {
  return (
    <FreshDialog
      open={open}
      onOpenChange={onOpenChange}
      height={form.description === undefined ? "14rem" : "17rem"}
    >
      <NameForm {...form} onDone={() => onOpenChange(false)} />
    </FreshDialog>
  );
}

function NameForm({
  title,
  description,
  initial = "",
  submitLabel = "Create",
  onSubmit,
  onDone,
}: Omit<NameDialogProps, "open" | "onOpenChange"> & { onDone: () => void }) {
  const form = useForm({
    defaultValues: { name: initial },
    onSubmit: async ({ value }) => {
      try {
        await onSubmit(value.name.trim());
      } catch {
        // Told of where it was asked for.
        return;
      }
      onDone();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <form
      data-console-name-dialog
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description === undefined ? null : <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      <DialogBody>
        <form.Field name="name" validators={{ onSubmit: required("A name") }}>
          {(field) => <TextField field={field} label="Name" autoFocus autoComplete="off" />}
        </form.Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
