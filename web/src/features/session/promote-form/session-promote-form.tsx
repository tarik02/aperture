import { Button } from "#/components/ui/button.tsx";
import { DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog.tsx";
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { TagEditor, entriesToTags } from "#/components/resources/tag-editor.tsx";
import { usePromoteSessionMutation } from "#/features/session/session.mutations.ts";
import { useSessionPromoteFormStore } from "#/features/session/promote-form/session-promote-form.store.ts";
import { useSessionPromoteModalStore } from "#/features/session/promote-modal/session-promote-modal.store.ts";

export function SessionPromoteForm() {
  const mutation = usePromoteSessionMutation();
  const draft = useSessionPromoteFormStore((state) => state.formData);
  const setFormData = useSessionPromoteFormStore((state) => state.setFormData);
  const closeModal = useSessionPromoteModalStore((state) => state.closeModal);
  const { sessionId, name, force, tagEntries, nameError } = draft;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!sessionId) {
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormData({ nameError: "Name required" });
      return;
    }

    setFormData({ nameError: null });
    await mutation.mutateAsync({
      sessionId,
      input: { name: trimmedName, force, tags: entriesToTags(tagEntries) },
    });
    closeModal();
  }

  return (
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
            onChange={(event) => setFormData({ name: event.target.value })}
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
            onCheckedChange={(checked) => setFormData({ force: checked })}
            disabled={mutation.isPending}
          />
        </Field>
        <TagEditor
          entries={tagEntries}
          onChange={(entries) => setFormData({ tagEntries: entries })}
          disabled={mutation.isPending}
        />
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={closeModal} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          Promote
        </Button>
      </DialogFooter>
    </form>
  );
}
