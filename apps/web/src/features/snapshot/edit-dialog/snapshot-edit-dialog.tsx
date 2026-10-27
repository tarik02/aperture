import { useForm, useStore } from "@tanstack/react-form";
import { useState } from "react";
import type { Snapshot } from "@aperture-browser/api-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Field, FieldLabel } from "@aperture-browser/ui/components/field";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { Textarea } from "@aperture-browser/ui/components/textarea";
import { useUpdateSnapshotMutation } from "#/features/snapshot/snapshot.mutations.ts";

type SnapshotEditDialogProps = {
  snapshot: Snapshot | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
};

export function SnapshotEditDialog({
  snapshot,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: SnapshotEditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete}>
      <DialogContent className="aperture:sm:max-w-lg">
        {snapshot ? (
          <SnapshotEditForm snapshot={snapshot} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const formId = "snapshot-edit-form";

function SnapshotEditForm({ snapshot, onDone }: { snapshot: Snapshot; onDone: () => void }) {
  const mutation = useUpdateSnapshotMutation();
  const [defaultValues] = useState(() => ({ description: snapshot.description ?? "" }));
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      const description = value.description.trim();
      const result = await mutation
        .mutateAsync({ name: snapshot.name, description: description === "" ? null : description })
        // The failure shows inline from mutation.error.
        .catch(() => null);
      if (result) {
        onDone();
      }
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <form
      id={formId}
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Edit "{snapshot.name}"</DialogTitle>
        <DialogDescription>
          Snapshots cannot be renamed. To use another name, save a session as a new snapshot and
          delete this one.
        </DialogDescription>
      </DialogHeader>
      <form.Field name="description">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="snapshot-description">Description</FieldLabel>
            <Textarea
              id="snapshot-description"
              autoFocus
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              disabled={submitting}
            />
          </Field>
        )}
      </form.Field>
      {mutation.error ? (
        <p className="aperture:text-sm aperture:text-destructive">{mutation.error.message}</p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={submitting}>
          {submitting ? <Spinner data-icon="inline-start" /> : null}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
