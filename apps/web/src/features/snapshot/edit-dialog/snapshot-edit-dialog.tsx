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
import {
  entriesToTags,
  TagEditor,
  tagsToEntries,
  type TagEntry,
} from "@aperture-browser/ui/components/tag-editor";
import { Textarea } from "@aperture-browser/ui/components/textarea";
import {
  useReplaceSnapshotTagsMutation,
  useUpdateSnapshotMutation,
} from "#/features/snapshot/snapshot.mutations.ts";

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
  const tagsMutation = useReplaceSnapshotTagsMutation();
  const [defaultValues] = useState(() => ({
    description: snapshot.description ?? "",
    tagEntries: tagsToEntries(snapshot.tags ?? {}) as TagEntry[],
  }));
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      const description = value.description.trim() || null;
      const tags = entriesToTags(value.tagEntries);
      // Each part saves only when it changed; a failure shows inline from the mutation's error.
      const descriptionSaved =
        description === (snapshot.description ?? null) ||
        (await mutation
          .mutateAsync({ name: snapshot.name, description })
          .then(() => true)
          .catch(() => false));
      const tagsSaved =
        sameTags(tags, snapshot.tags ?? {}) ||
        (await tagsMutation
          .mutateAsync({ name: snapshot.name, tags })
          .then(() => true)
          .catch(() => false));
      if (descriptionSaved && tagsSaved) {
        onDone();
      }
    },
  });
  const error = mutation.error ?? tagsMutation.error;
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
      <form.Field name="tagEntries">
        {(field) => (
          <TagEditor
            entries={field.state.value}
            onChange={field.handleChange}
            disabled={submitting}
          />
        )}
      </form.Field>
      {error ? <p className="aperture:text-sm aperture:text-destructive">{error.message}</p> : null}
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

function sameTags(left: Record<string, string>, right: Record<string, string>) {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}
