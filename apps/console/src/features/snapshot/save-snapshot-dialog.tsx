import { Button } from "@aperture-browser/ui/components/button";
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@aperture-browser/ui/components/field";
import { Label } from "@aperture-browser/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@aperture-browser/ui/components/radio-group";
import {
  entriesToTags,
  TagEditor,
  tagsToEntries,
} from "@aperture-browser/ui/components/tag-editor";
import { Textarea } from "@aperture-browser/ui/components/textarea";
import { useForm, useStore } from "@tanstack/react-form";
import { useId } from "react";
import { Choice } from "#/components/choice.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { TextField } from "#/components/text-field.tsx";
import type { Session } from "#/features/session/session.queries.ts";
import { useTakeSnapshotMutation } from "#/features/snapshot/snapshot.mutations.ts";
import { type Snapshot, useSnapshotsQuery } from "#/features/snapshot/snapshot.queries.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type SaveSnapshotDialogProps = {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Keeps a session's profile as it is now: as a new snapshot, or in the place of another. */
export function SaveSnapshotDialog({ session, open, onOpenChange }: SaveSnapshotDialogProps) {
  const snapshots = useSnapshotsQuery();
  return (
    <FreshDialog open={open} onOpenChange={onOpenChange} className="aperture:sm:max-w-lg">
      {/* What may be replaced decides how the form starts, so the form waits for it. */}
      {snapshots.isPending ? (
        <>
          <SaveHeader />
          <DialogBody height={HEIGHT} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled>
              Save snapshot
            </Button>
          </DialogFooter>
        </>
      ) : (
        <SaveForm
          session={session}
          // A snapshot takes the place of another of the same workspace, newest first.
          replaceable={(snapshots.data ?? [])
            .filter((snapshot) => snapshot.workspaceId === session.workspaceId)
            .toSorted(
              (one, other) => other.createdAt.epochMilliseconds - one.createdAt.epochMilliseconds,
            )}
          onDone={() => onOpenChange(false)}
        />
      )}
    </FreshDialog>
  );
}

/** The taller of the two it asks for, which is the one that replaces, and three tags. */
const HEIGHT = "calc(16.75rem + 7 * var(--control-height))";

function SaveHeader() {
  return (
    <DialogHeader>
      <DialogTitle>Save to snapshot</DialogTitle>
    </DialogHeader>
  );
}

type SaveFormProps = {
  session: Session;
  replaceable: ReadonlyArray<Snapshot>;
  onDone: () => void;
};

function SaveForm({ session, replaceable, onDone }: SaveFormProps) {
  const take = useTakeSnapshotMutation();
  const replacesId = useId();
  const descriptionId = useId();
  // The one the session started from is the one it most likely brings up to date.
  const from = replaceable.find((snapshot) => snapshot.id === session.snapshotId);
  const first = from ?? replaceable.find((snapshot) => snapshot.sessionId === session.id);
  const form = useForm({
    defaultValues: {
      mode: (from === undefined ? "new" : "replace") as "replace" | "new",
      replaces: (first ?? replaceable[0])?.id ?? "",
      name: "",
      description: from?.description ?? "",
      tags: tagsToEntries({ ...from?.tags }),
    },
    onSubmit: async ({ value }) => {
      const replaces = value.mode === "replace" && value.replaces !== "";
      try {
        await take.mutateAsync({
          sessionId: session.id,
          // What is left out stays as the replaced snapshot had it.
          name: replaces || value.name.trim() === "" ? undefined : value.name.trim(),
          description: value.description.trim() === "" ? undefined : value.description.trim(),
          tags: entriesToTags(value.tags),
          replaces: replaces ? value.replaces : undefined,
        });
      } catch {
        // The mutation tells of it.
        return;
      }
      onDone();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const mode = useStore(form.store, (state) => state.values.mode);

  // What is said of a snapshot follows the one that is replaced, until another is.
  const describeAs = (snapshot: Snapshot | undefined) => {
    form.setFieldValue("description", snapshot?.description ?? "");
    form.setFieldValue("tags", tagsToEntries({ ...snapshot?.tags }));
  };
  const chosen = (id: string) => replaceable.find((snapshot) => snapshot.id === id);

  return (
    <form
      data-console-save-snapshot
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <SaveHeader />
      <DialogBody height={HEIGHT}>
        {replaceable.length === 0 ? null : (
          <form.Field name="mode">
            {(field) => (
              <RadioGroup
                value={field.state.value}
                disabled={submitting}
                onValueChange={(value) => {
                  const next = value === "replace" ? "replace" : "new";
                  field.handleChange(next);
                  describeAs(
                    next === "replace" ? chosen(form.getFieldValue("replaces")) : undefined,
                  );
                }}
              >
                <Label className="aperture:font-normal">
                  <RadioGroupItem value="replace" data-console-save-snapshot-mode="replace" />
                  Replace a snapshot
                </Label>
                <Label className="aperture:font-normal">
                  <RadioGroupItem value="new" data-console-save-snapshot-mode="new" />
                  Save as a new snapshot
                </Label>
              </RadioGroup>
            )}
          </form.Field>
        )}
        {mode === "replace" ? (
          <form.Field name="replaces">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={replacesId}>Snapshot</FieldLabel>
                <Choice
                  id={replacesId}
                  className="aperture:w-full"
                  value={field.state.value}
                  options={replaceable.map((snapshot) => ({
                    value: snapshot.id,
                    label: `${snapshot.name ?? "Unnamed"} · ${when.format(new Date(snapshot.createdAt.epochMilliseconds))}`,
                  }))}
                  onChange={(id) => {
                    field.handleChange(id);
                    describeAs(chosen(id));
                  }}
                />
                <FieldDescription>
                  It is deleted once this one is saved, which keeps its name. Sessions started from
                  it keep working.
                </FieldDescription>
              </Field>
            )}
          </form.Field>
        ) : (
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
        )}
        <form.Field name="description">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
              <Textarea
                id={descriptionId}
                name={field.name}
                placeholder="What is signed in, and what it is for"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="tags">
          {(field) => <TagEditor entries={field.state.value} onChange={field.handleChange} />}
        </form.Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={submitting}>
          {mode === "replace" ? "Replace snapshot" : "Save snapshot"}
        </Button>
      </DialogFooter>
    </form>
  );
}
