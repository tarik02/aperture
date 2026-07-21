import { Pause } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { TagEditor, entriesToTags } from "#/components/resources/tag-editor.tsx";
import {
  usePromoteSessionMutation,
  useSuspendSessionMutation,
} from "#/features/session/session.mutations.ts";
import { useSessionPromoteFormStore } from "#/features/session/promote-form/session-promote-form.store.ts";
import { useSessionPromoteModalStore } from "#/features/session/promote-modal/session-promote-modal.store.ts";

export function SessionPromoteForm() {
  const mutation = usePromoteSessionMutation();
  const suspendMutation = useSuspendSessionMutation();
  const draft = useSessionPromoteFormStore((state) => state.formData);
  const setFormData = useSessionPromoteFormStore((state) => state.setFormData);
  const closeModal = useSessionPromoteModalStore((state) => state.closeModal);
  const setModalPending = useSessionPromoteModalStore((state) => state.setPending);
  const {
    sessionId,
    name,
    description,
    replaceExisting,
    suspendBeforePromote,
    tagEntries,
    nameError,
  } = draft;
  const pending = mutation.isPending || suspendMutation.isPending;

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
    setModalPending(true);
    try {
      if (suspendBeforePromote) {
        await suspendMutation.mutateAsync(sessionId);
        setFormData({ suspendBeforePromote: false });
      }
      await mutation.mutateAsync({
        sessionId,
        input: {
          name: trimmedName,
          description: description === "" ? null : description,
          force: replaceExisting,
          tags: entriesToTags(tagEntries),
        },
      });
    } finally {
      setModalPending(false);
    }
    closeModal();
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <DialogHeader>
        <DialogTitle>Promote session</DialogTitle>
        <DialogDescription>Create a reusable snapshot from this session.</DialogDescription>
      </DialogHeader>
      {suspendBeforePromote ? (
        <Alert>
          <Pause />
          <AlertTitle>Session will be suspended</AlertTitle>
          <AlertDescription>
            This running session will be suspended before promotion.
          </AlertDescription>
        </Alert>
      ) : null}
      <FieldGroup className="py-2">
        <Field
          data-invalid={nameError ? true : undefined}
          data-disabled={pending ? true : undefined}
        >
          <FieldLabel htmlFor="promote-name">Snapshot name</FieldLabel>
          <Input
            id="promote-name"
            value={name}
            onChange={(event) => setFormData({ name: event.target.value })}
            aria-invalid={nameError ? true : undefined}
            disabled={pending}
          />
          <FieldError>{nameError}</FieldError>
        </Field>
        <Field data-disabled={pending ? true : undefined}>
          <FieldLabel htmlFor="promote-description">Description</FieldLabel>
          <Textarea
            id="promote-description"
            value={description}
            onChange={(event) => setFormData({ description: event.target.value })}
            disabled={pending}
          />
        </Field>
        <Field orientation="horizontal" data-disabled={pending ? true : undefined}>
          <FieldContent>
            <FieldLabel htmlFor="promote-replace">Replace existing snapshot</FieldLabel>
            <FieldDescription>
              If an active snapshot uses this name, it will be deleted and replaced.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="promote-replace"
            checked={replaceExisting}
            onCheckedChange={(checked) => setFormData({ replaceExisting: checked })}
            disabled={pending}
          />
        </Field>
        <TagEditor
          entries={tagEntries}
          onChange={(entries) => setFormData({ tagEntries: entries })}
          disabled={pending}
        />
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={closeModal} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {suspendMutation.isPending
            ? "Suspending..."
            : mutation.isPending
              ? "Promoting..."
              : suspendBeforePromote
                ? "Suspend and promote"
                : "Promote"}
        </Button>
      </DialogFooter>
    </form>
  );
}
