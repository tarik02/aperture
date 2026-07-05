import { useEffect } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { TagEditor, entriesToTags } from "#/components/resources/tag-editor.tsx";
import { usePromoteSessionMutation } from "#/hooks/mutations/use-session-mutations.ts";
import type { Session } from "#/lib/api/schemas.ts";
import { useFormDraftStore } from "#/stores/form-drafts.ts";

type PromoteSessionDialogProps = {
  session: Session | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function PromoteSessionDialog({ session, open, onOpenChange }: PromoteSessionDialogProps) {
  const mutation = usePromoteSessionMutation();
  const draft = useFormDraftStore((state) => state.promoteSession);
  const setPromoteSession = useFormDraftStore((state) => state.setPromoteSession);
  const resetPromoteSession = useFormDraftStore((state) => state.resetPromoteSession);
  const { name, force, tagEntries, nameError } = draft;

  useEffect(() => {
    if (open) {
      resetPromoteSession();
    }
  }, [open, resetPromoteSession]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!session) {
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      setPromoteSession({ nameError: "Name required" });
      return;
    }

    setPromoteSession({ nameError: null });
    await mutation.mutateAsync({
      sessionId: session.id,
      input: { name: trimmedName, force, tags: entriesToTags(tagEntries) },
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
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
                onChange={(event) => setPromoteSession({ name: event.target.value })}
                disabled={mutation.isPending}
              />
              <FieldError>{nameError}</FieldError>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="promote-force">Force</FieldLabel>
              </FieldContent>
              <Switch
                id="promote-force"
                checked={force}
                onCheckedChange={(checked) => setPromoteSession({ force: checked })}
                disabled={mutation.isPending}
              />
            </Field>
            <TagEditor
              entries={tagEntries}
              onChange={(entries) => setPromoteSession({ tagEntries: entries })}
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
