import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Input } from "@aperture-browser/ui/components/input";
import {
  entriesToTags,
  TagEditor,
  type TagEntry,
  tagsToEntries,
} from "@aperture-browser/ui/components/tag-editor";
import { Textarea } from "@aperture-browser/ui/components/textarea";
import { type FormEvent, useState } from "react";

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
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (described: Described) => void;
};

/** Changes what something is called, said to be and tagged with. */
export function DescribeDialog(props: DescribeDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        {/* Mounted with the dialog, so it starts from what is kept each time it opens. */}
        {props.open ? <DescribeForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function DescribeForm({
  title,
  nameLabel,
  withDescription = false,
  initial,
  pending,
  onOpenChange,
  onSubmit,
}: DescribeDialogProps) {
  const [name, setName] = useState(initial.name ?? "");
  const [description, setDescription] = useState(initial.description ?? "");
  const [tags, setTags] = useState<TagEntry[]>(() => tagsToEntries({ ...initial.tags }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      name: name.trim() === "" ? null : name.trim(),
      description: description.trim() === "" ? null : description.trim(),
      tags: entriesToTags(tags),
    });
  };

  return (
    <form data-console-describe onSubmit={submit} className="aperture:grid aperture:gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <label className="aperture:grid aperture:gap-1.5 aperture:text-sm">
        {nameLabel}
        <Input
          name="name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {withDescription ? (
        <label className="aperture:grid aperture:gap-1.5 aperture:text-sm">
          Description
          <Textarea
            name="description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      ) : null}
      <TagEditor entries={tags} onChange={setTags} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
