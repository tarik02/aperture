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
import { useAddPasskeyMutation, useRenamePasskeyMutation } from "#/features/auth/auth.mutations.ts";
import { told } from "#/lib/api.ts";
import { calledOff, type Passkey } from "#/lib/identity.ts";
import { required } from "#/lib/validation.ts";

type PasskeyNameDialogProps = {
  /** The passkey that is named anew; one is added under the name, without. */
  passkey: Passkey | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function PasskeyNameDialog({ passkey, open, onOpenChange }: PasskeyNameDialogProps) {
  return (
    <FreshDialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>{passkey === undefined ? "Add a passkey" : "Rename the passkey"}</DialogTitle>
      </DialogHeader>
      <PasskeyName passkey={passkey} onDone={() => onOpenChange(false)} />
    </FreshDialog>
  );
}

/** Names a passkey: the one there is, or one an authenticator is then asked to make. */
function PasskeyName({ passkey, onDone }: { passkey: Passkey | undefined; onDone: () => void }) {
  const add = useAddPasskeyMutation();
  const rename = useRenamePasskeyMutation();
  const [refused, setRefused] = useState<string>();
  const form = useForm({
    defaultValues: { name: passkey?.name ?? "" },
    onSubmit: async ({ value }) => {
      const name = value.name.trim();
      setRefused(undefined);
      try {
        await (passkey === undefined
          ? add.mutateAsync(name)
          : rename.mutateAsync({ id: passkey.id, name }));
      } catch (error) {
        // Whoever called it off themselves is told nothing of that.
        setRefused(
          calledOff(error)
            ? undefined
            : told(error, passkey === undefined ? "No passkey was added." : "It was not renamed."),
        );
        return;
      }
      onDone();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <form
      data-console-security-dialog="passkey-name"
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogBody>
        <form.Field name="name" validators={{ onSubmit: required("A name") }}>
          {(field) => (
            <TextField
              field={field}
              label="Name"
              placeholder="Laptop"
              autoFocus
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
          {passkey === undefined ? "Add" : "Rename"}
        </Button>
      </DialogFooter>
    </form>
  );
}
