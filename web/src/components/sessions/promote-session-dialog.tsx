import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import { Label } from "#/components/ui/label.tsx";
import { TagEditor, entriesToTags, type TagEntry } from "#/components/resources/tag-editor.tsx";
import { usePromoteSessionMutation } from "#/hooks/mutations/use-session-mutations.ts";
import type { Session } from "#/lib/api/schemas.ts";

type PromoteSessionDialogProps = {
  session: Session | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function PromoteSessionDialog({ session, open, onOpenChange }: PromoteSessionDialogProps) {
  const mutation = usePromoteSessionMutation();
  const [name, setName] = useState("");
  const [force, setForce] = useState(false);
  const [tagEntries, setTagEntries] = useState<TagEntry[]>([]);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setForce(false);
      setTagEntries([]);
      setNameError(null);
    }
  }, [open]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!session) {
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("Name required");
      return;
    }

    setNameError(null);
    await mutation.mutateAsync({
      sessionId: session.id,
      input: { name: trimmedName, force, tags: entriesToTags(tagEntries) },
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>Promote</DialogTitle>
          </DialogHeader>
          <FieldGroup className="py-2">
            <Field data-invalid={nameError ? true : undefined}>
              <FieldLabel htmlFor="promote-name">Snapshot name</FieldLabel>
              <Input
                id="promote-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={mutation.isPending}
              />
              <FieldError>{nameError}</FieldError>
            </Field>
            <div className="flex items-center gap-2">
              <Checkbox
                id="promote-force"
                checked={force}
                onCheckedChange={(checked) => setForce(checked === true)}
                disabled={mutation.isPending}
              />
              <Label htmlFor="promote-force">Force</Label>
            </div>
            <TagEditor
              entries={tagEntries}
              onChange={setTagEntries}
              disabled={mutation.isPending}
            />
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              Promote
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
