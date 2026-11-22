import { Button } from "@aperture-browser/ui/components/button";
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Field, FieldLabel } from "@aperture-browser/ui/components/field";
import {
  entriesToTags,
  TagEditor,
  tagsToEntries,
} from "@aperture-browser/ui/components/tag-editor";
import { Textarea } from "@aperture-browser/ui/components/textarea";
import { useForm, useStore } from "@tanstack/react-form";
import { useId } from "react";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { TextField } from "#/components/text-field.tsx";

export interface Described {
  readonly name: string | null;
  readonly description: string | null;
  readonly tags: Record<string, string>;
}

type DescribeDialogProps = {
  title: string;
  /** What the name is called here: a session's is its label. */
  nameLabel: string;
  /** Whether what is described has a description as well. */
  withDescription?: boolean;
  initial: {
    name: string | null;
    description?: string | null;
    tags: Readonly<Record<string, string>>;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Keeps what was said; the dialog closes once it is kept, and stays when it is not. */
  onSubmit: (described: Described) => Promise<unknown>;
};

/** Changes what something is called, said to be and tagged with. */
export function DescribeDialog({ open, onOpenChange, ...form }: DescribeDialogProps) {
  return (
    <FreshDialog
      open={open}
      onOpenChange={onOpenChange}
      className="aperture:sm:max-w-lg"
      height={form.withDescription === true ? "32rem" : "26rem"}
    >
      <DescribeForm {...form} onDone={() => onOpenChange(false)} />
    </FreshDialog>
  );
}

function DescribeForm({
  title,
  nameLabel,
  withDescription = false,
  initial,
  onSubmit,
  onDone,
}: Omit<DescribeDialogProps, "open" | "onOpenChange"> & { onDone: () => void }) {
  const descriptionId = useId();
  const form = useForm({
    defaultValues: {
      name: initial.name ?? "",
      description: initial.description ?? "",
      tags: tagsToEntries({ ...initial.tags }),
    },
    onSubmit: async ({ value }) => {
      try {
        await onSubmit({
          name: value.name.trim() === "" ? null : value.name.trim(),
          description: value.description.trim() === "" ? null : value.description.trim(),
          tags: entriesToTags(value.tags),
        });
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
      data-console-describe
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <form.Field name="name">
          {(field) => <TextField field={field} label={nameLabel} autoFocus autoComplete="off" />}
        </form.Field>
        {withDescription ? (
          <form.Field name="description">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
                <Textarea
                  id={descriptionId}
                  name={field.name}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
        ) : null}
        <form.Field name="tags">
          {(field) => <TagEditor entries={field.state.value} onChange={field.handleChange} />}
        </form.Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={submitting}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
