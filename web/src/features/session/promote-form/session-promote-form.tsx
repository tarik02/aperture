import { Pause } from "lucide-react";
import { useMemo } from "react";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "#/components/ui/combobox.tsx";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "#/components/ui/field.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { TagEditor, entriesToTags, tagsToEntries } from "#/components/resources/tag-editor.tsx";
import {
  usePromoteSessionMutation,
  useSuspendSessionMutation,
} from "#/features/session/session.mutations.ts";
import { useSessionPromoteFormStore } from "#/features/session/promote-form/session-promote-form.store.ts";
import { useSessionPromoteModalStore } from "#/features/session/promote-modal/session-promote-modal.store.ts";
import { useSnapshotsInfiniteQuery } from "#/features/snapshot/snapshot.queries.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";

export function SessionPromoteForm() {
  const mutation = usePromoteSessionMutation();
  const suspendMutation = useSuspendSessionMutation();
  const draft = useSessionPromoteFormStore((state) => state.formData);
  const setFormData = useSessionPromoteFormStore((state) => state.setFormData);
  const closeModal = useSessionPromoteModalStore((state) => state.closeModal);
  const setModalPending = useSessionPromoteModalStore((state) => state.setPending);
  const { sessionId, name, description, suspendBeforePromote, tagEntries, nameError } = draft;
  const pending = mutation.isPending || suspendMutation.isPending;
  const trimmedName = name.trim();
  const snapshotsQuery = useSnapshotsInfiniteQuery({
    limit: 100,
    name: trimmedName || undefined,
  });
  const snapshots = useMemo(
    () => flattenInfinitePages(snapshotsQuery.data?.pages),
    [snapshotsQuery.data?.pages],
  );
  const snapshotNames = useMemo(() => snapshots.map((snapshot) => snapshot.name), [snapshots]);
  const existingSnapshot = useMemo(
    () => snapshots.find((snapshot) => snapshot.name === trimmedName),
    [snapshots, trimmedName],
  );
  const replacingExistingSnapshot = existingSnapshot !== undefined;
  const effectiveDescription = existingSnapshot
    ? (existingSnapshot.description ?? "")
    : description;
  const effectiveTagEntries = useMemo(
    () => (existingSnapshot ? tagsToEntries(existingSnapshot.tags ?? {}) : tagEntries),
    [existingSnapshot, tagEntries],
  );
  const snapshotSearchPending = trimmedName !== "" && snapshotsQuery.isFetching;
  const snapshotSearchError = snapshotsQuery.isError ? "Snapshot search failed" : null;
  const displayedNameError = nameError ?? snapshotSearchError;

  function handleNameChange(nextName: string) {
    setFormData({
      name: nextName,
      description: replacingExistingSnapshot ? "" : description,
      tagEntries: replacingExistingSnapshot ? [] : tagEntries,
      nameError: null,
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!sessionId) {
      return;
    }

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
          description: effectiveDescription === "" ? null : effectiveDescription,
          force: replacingExistingSnapshot,
          tags: entriesToTags(effectiveTagEntries),
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
          data-invalid={displayedNameError ? true : undefined}
          data-disabled={pending ? true : undefined}
        >
          <FieldLabel htmlFor="promote-name">Snapshot name</FieldLabel>
          <Combobox
            items={snapshotNames}
            filter={null}
            value={existingSnapshot?.name ?? null}
            inputValue={name}
            onInputValueChange={handleNameChange}
            onValueChange={(value) => {
              if (typeof value === "string") {
                handleNameChange(value);
              }
            }}
            disabled={pending}
          >
            <ComboboxInput
              id="promote-name"
              placeholder="Search or enter a new snapshot name"
              className="w-full"
              aria-invalid={displayedNameError ? true : undefined}
              disabled={pending}
              showClear
            />
            <ComboboxContent align="start" className="w-(--anchor-width)">
              <ComboboxEmpty>
                {snapshotsQuery.isFetching
                  ? "Searching snapshots..."
                  : snapshotSearchError
                    ? snapshotSearchError
                    : trimmedName
                      ? `No match. "${trimmedName}" will be created.`
                      : "No snapshots found"}
              </ComboboxEmpty>
              <ComboboxList>
                {(snapshotName: string) => (
                  <ComboboxItem key={snapshotName} value={snapshotName}>
                    {snapshotName}
                  </ComboboxItem>
                )}
              </ComboboxList>
              {snapshotsQuery.hasNextPage ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="m-1 w-[calc(100%-0.5rem)]"
                  onClick={() => void snapshotsQuery.fetchNextPage()}
                  disabled={snapshotsQuery.isFetchingNextPage}
                >
                  {snapshotsQuery.isFetchingNextPage ? "Loading..." : "Load more snapshots"}
                </Button>
              ) : null}
            </ComboboxContent>
          </Combobox>
          <FieldDescription>
            {replacingExistingSnapshot
              ? "The selected snapshot will be replaced with the same description and tags."
              : "Type a new name to create a snapshot."}
          </FieldDescription>
          <FieldError>{displayedNameError}</FieldError>
        </Field>
        <Field data-disabled={pending || replacingExistingSnapshot ? true : undefined}>
          <FieldLabel htmlFor="promote-description">Description</FieldLabel>
          <Textarea
            id="promote-description"
            value={effectiveDescription}
            onChange={(event) => setFormData({ description: event.target.value })}
            disabled={pending || replacingExistingSnapshot}
          />
        </Field>
        <TagEditor
          entries={effectiveTagEntries}
          onChange={(entries) => setFormData({ tagEntries: entries })}
          disabled={pending || replacingExistingSnapshot}
        />
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={closeModal} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={pending || snapshotSearchPending || snapshotSearchError !== null}
        >
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
