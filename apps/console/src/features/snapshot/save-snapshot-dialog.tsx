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
import { useTakeSnapshotMutation } from "#/features/snapshot/snapshot.mutations.ts";

type SaveSnapshotDialogProps = {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Keeps a session's profile as it is now, under a name. */
export function SaveSnapshotDialog({ sessionId, open, onOpenChange }: SaveSnapshotDialogProps) {
  return (
    <FreshDialog open={open} onOpenChange={onOpenChange}>
      <SaveForm sessionId={sessionId} onDone={() => onOpenChange(false)} />
    </FreshDialog>
  );
}

function SaveForm({ sessionId, onDone }: { sessionId: string; onDone: () => void }) {
  const take = useTakeSnapshotMutation();
  const form = useForm({
    defaultValues: { name: "" },
    onSubmit: async ({ value }) => {
      try {
        await take.mutateAsync({
          sessionId,
          name: value.name.trim() === "" ? undefined : value.name.trim(),
        });
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
      data-console-save-snapshot
      className="aperture:grid aperture:gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Save to snapshot</DialogTitle>
        <DialogDescription>
          The session's profile as it is now: its cookies, storage and extensions. New sessions
          start from it.
        </DialogDescription>
      </DialogHeader>
      <form.Field name="name">
        {(field) => (
          <TextField
            field={field}
            label="Name"
            placeholder="Optional"
            autoFocus
            autoComplete="off"
          />
        )}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
