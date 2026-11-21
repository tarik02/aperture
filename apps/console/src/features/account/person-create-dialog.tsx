import { Button } from "@aperture-browser/ui/components/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { useForm, useStore } from "@tanstack/react-form";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { TextField } from "#/components/text-field.tsx";
import { useCreateAccountMutation } from "#/features/account/account.mutations.ts";
import { all, email, required } from "#/lib/validation.ts";

type PersonCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** A new account of a person's, who signs in with their address. */
export function PersonCreateDialog({ open, onOpenChange }: PersonCreateDialogProps) {
  return (
    <FreshDialog open={open} onOpenChange={onOpenChange}>
      <CreateForm onDone={() => onOpenChange(false)} />
    </FreshDialog>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const create = useCreateAccountMutation();
  const form = useForm({
    defaultValues: { name: "", email: "" },
    onSubmit: async ({ value }) => {
      try {
        await create.mutateAsync({ name: value.name.trim(), email: value.email.trim() });
      } catch {
        // The mutation tells of it.
        return;
      }
      onDone();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <form
      data-console-person-create
      noValidate
      className="aperture:grid aperture:gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>New person</DialogTitle>
        <DialogDescription>
          They sign in once they set a password with a setup link, which you give them.
        </DialogDescription>
      </DialogHeader>
      <form.Field name="name" validators={{ onSubmit: required("A name") }}>
        {(field) => <TextField field={field} label="Name" autoFocus autoComplete="off" />}
      </form.Field>
      <form.Field name="email" validators={{ onSubmit: all(required("An email"), email) }}>
        {(field) => <TextField field={field} label="Email" type="email" autoComplete="off" />}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
