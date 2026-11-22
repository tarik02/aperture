import { Button } from "@aperture-browser/ui/components/button";
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { useForm, useStore } from "@tanstack/react-form";
import { useState } from "react";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { TextField } from "#/components/text-field.tsx";
import { useCreateAccountMutation } from "#/features/account/account.mutations.ts";
import type { Account } from "#/features/account/account.queries.ts";
import { told } from "#/lib/api.ts";
import { all, email, required } from "#/lib/validation.ts";

type PersonCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hears who was made, once the dialog closes: they are given a setup link next. */
  onCreated: (account: Pick<Account, "id" | "email">) => void;
};

/** A new account of a person's, who signs in with their address. */
export function PersonCreateDialog({ open, onOpenChange, onCreated }: PersonCreateDialogProps) {
  return (
    <FreshDialog open={open} onOpenChange={onOpenChange}>
      <CreateForm onCreated={onCreated} onDone={() => onOpenChange(false)} />
    </FreshDialog>
  );
}

function CreateForm({
  onCreated,
  onDone,
}: Pick<PersonCreateDialogProps, "onCreated"> & { onDone: () => void }) {
  const create = useCreateAccountMutation({ quiet: true });
  /** What the control plane refused: said at the address, which is what it refuses. */
  const [refused, setRefused] = useState<string>();
  const form = useForm({
    defaultValues: { name: "", email: "" },
    onSubmit: async ({ value }) => {
      setRefused(undefined);
      try {
        const made = await create.mutateAsync({
          name: value.name.trim(),
          email: value.email.trim(),
        });
        onDone();
        onCreated(made);
      } catch (error) {
        setRefused(told(error, "The account was not made."));
      }
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <form
      data-console-person-create
      noValidate
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>New person</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <form.Field name="name" validators={{ onSubmit: required("A name") }}>
          {(field) => <TextField field={field} label="Name" autoFocus autoComplete="off" />}
        </form.Field>
        <form.Field name="email" validators={{ onSubmit: all(required("An email"), email) }}>
          {(field) => (
            <TextField
              field={field}
              label="Email"
              type="email"
              autoComplete="off"
              refused={refused}
            />
          )}
        </form.Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={submitting}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
