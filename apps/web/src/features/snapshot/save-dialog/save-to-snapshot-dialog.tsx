import { useForm, useStore } from "@tanstack/react-form";
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { flattenInfinitePages, type Session, type Snapshot } from "@aperture-browser/api-client";
import { Alert, AlertDescription } from "@aperture-browser/ui/components/alert";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@aperture-browser/ui/components/field";
import { Input } from "@aperture-browser/ui/components/input";
import { Label } from "@aperture-browser/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@aperture-browser/ui/components/radio-group";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { Textarea } from "@aperture-browser/ui/components/textarea";
import { useSaveToSnapshotMutation } from "#/features/session/session.mutations.ts";
import { sessionLabel } from "#/features/session/session-display.ts";
import { useSnapshotsInfiniteQuery } from "#/features/snapshot/snapshot.queries.ts";

export interface SaveToSnapshotRequest {
  readonly session: Session;
  /** Update this snapshot instead of the one the session started from. */
  readonly target?: Snapshot;
  /** Workbench tabs, this one included, that disconnect when the session suspends. */
  readonly openTabs: number;
}

type SaveToSnapshotDialogProps = {
  request: SaveToSnapshotRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
};

export function SaveToSnapshotDialog({
  request,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: SaveToSnapshotDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete}>
      <DialogContent className="aperture:sm:max-w-lg">
        {request ? (
          <SaveToSnapshotForm request={request} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const formId = "save-to-snapshot-form";

function SaveToSnapshotForm({
  request,
  onDone,
}: {
  request: SaveToSnapshotRequest;
  onDone: () => void;
}) {
  const { session, target, openTabs } = request;
  const mutation = useSaveToSnapshotMutation();
  // An open tab keeps the session awake even when its cached status still says suspended.
  const running = session.status === "running" || openTabs > 0;

  const baseName = target?.name ?? session.baseSnapshotName ?? null;
  const baseQuery = useSnapshotsInfiniteQuery(
    { name: baseName ?? undefined, limit: 20 },
    {
      enabled: baseName !== null,
    },
  );
  const baseSnapshot = useMemo(
    () =>
      target ??
      flattenInfinitePages(baseQuery.data?.pages).find((snapshot) => snapshot.name === baseName),
    [baseName, baseQuery.data?.pages, target],
  );

  // "Update it instead" can point at another snapshot than the one the session started from.
  const [chosenTarget, setChosenTarget] = useState<Snapshot | null>(null);
  const updateTarget = chosenTarget ?? baseSnapshot;
  const resolved = useRef({ updateTarget, mode: "new" as "update" | "new" });

  const [defaultValues] = useState(() => ({
    mode: (baseName !== null ? "update" : "new") as "update" | "new",
    name: "",
    // Null follows the description of the snapshot being updated until the user edits it.
    description: null as string | null,
  }));
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      const { updateTarget, mode } = resolved.current;
      const updating = mode === "update" && updateTarget !== undefined;
      const description = (
        value.description ?? (updating ? (updateTarget.description ?? "") : "")
      ).trim();
      const result = await mutation
        .mutateAsync({
          session,
          name: updating ? updateTarget.name : value.name.trim(),
          description: description === "" ? null : description,
          replace: updating,
        })
        // The failure shows inline from mutation.error.
        .catch(() => null);
      if (!result) {
        return;
      }
      toast.success(
        updating
          ? `Snapshot "${result.snapshot.name}" updated`
          : `Snapshot "${result.snapshot.name}" saved`,
      );
      onDone();
    },
  });

  const mode = useStore(form.store, (state) => state.values.mode);
  const name = useStore(form.store, (state) => state.values.name);
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const trimmedName = useDeferredValue(name.trim());

  const nameQuery = useSnapshotsInfiniteQuery(
    { name: trimmedName || undefined, limit: 100 },
    { enabled: mode === "new" && trimmedName !== "" },
  );
  const takenSnapshot = useMemo(
    () =>
      trimmedName === ""
        ? undefined
        : flattenInfinitePages(nameQuery.data?.pages).find(
            (snapshot) => snapshot.name === trimmedName,
          ),
    [nameQuery.data?.pages, trimmedName],
  );
  const checkingName = mode === "new" && trimmedName !== "" && nameQuery.isFetching;
  const effectiveMode = updateTarget !== undefined ? mode : "new";
  resolved.current = { updateTarget, mode: effectiveMode };

  const prefilledDescription = effectiveMode === "update" ? (updateTarget?.description ?? "") : "";

  function switchToUpdate(snapshot: Snapshot) {
    setChosenTarget(snapshot);
    form.setFieldValue("mode", "update");
  }

  const submitDisabled =
    submitting ||
    (effectiveMode === "new" &&
      (name.trim() === "" || takenSnapshot !== undefined || checkingName));

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
        <DialogTitle>Save to snapshot</DialogTitle>
        <DialogDescription>
          New sessions can start from a copy of this session's logins and browser state. Later
          changes in this session are not saved unless you save it again.
          {running ? " Saving suspends this session; it wakes again when you open it." : null}
        </DialogDescription>
      </DialogHeader>

      {running && openTabs > 0 ? (
        <Alert>
          <AlertDescription>
            {openTabs === 1
              ? "This session is open in 1 tab, which disconnects when the session is suspended."
              : `This session is open in ${openTabs} tabs, which disconnect when the session is suspended.`}
          </AlertDescription>
        </Alert>
      ) : null}

      <FieldGroup>
        {updateTarget !== undefined ? (
          <form.Field name="mode">
            {(field) => (
              <RadioGroup
                value={effectiveMode}
                onValueChange={(value) => {
                  field.handleChange(value === "update" ? "update" : "new");
                }}
                disabled={submitting}
              >
                <Label className="aperture:font-normal">
                  <RadioGroupItem value="update" />
                  Update snapshot "{updateTarget.name}"
                </Label>
                <Label className="aperture:font-normal">
                  <RadioGroupItem value="new" />
                  Save as new snapshot
                </Label>
              </RadioGroup>
            )}
          </form.Field>
        ) : null}

        {effectiveMode === "new" ? (
          <form.Field name="name">
            {(field) => (
              <Field data-invalid={takenSnapshot ? true : undefined}>
                <FieldLabel htmlFor="save-snapshot-name">Name</FieldLabel>
                <Input
                  id="save-snapshot-name"
                  autoFocus
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder={sessionLabel(session)}
                  disabled={submitting}
                  autoComplete="off"
                />
                {takenSnapshot ? (
                  <FieldError>
                    A snapshot named "{takenSnapshot.name}" already exists.{" "}
                    <button
                      type="button"
                      className="aperture:font-medium aperture:underline aperture:underline-offset-4"
                      onClick={() => switchToUpdate(takenSnapshot)}
                    >
                      Update it instead
                    </button>
                  </FieldError>
                ) : (
                  <FieldDescription>Snapshots cannot be renamed later.</FieldDescription>
                )}
              </Field>
            )}
          </form.Field>
        ) : null}

        <form.Field name="description">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="save-snapshot-description">Description</FieldLabel>
              <Textarea
                id="save-snapshot-description"
                value={field.state.value ?? prefilledDescription}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="What is signed in, and what it is for"
                disabled={submitting}
              />
              {effectiveMode === "update" ? (
                <FieldDescription>
                  Sessions already started from this snapshot keep their own copy.
                </FieldDescription>
              ) : null}
            </Field>
          )}
        </form.Field>
      </FieldGroup>

      {mutation.error ? (
        <p className="aperture:text-sm aperture:text-destructive">{mutation.error.message}</p>
      ) : null}

      <DialogFooter className="aperture:items-center">
        {submitting ? (
          <span className="aperture:mr-auto aperture:flex aperture:items-center aperture:gap-2 aperture:text-sm aperture:text-muted-foreground">
            <Spinner />
            {running ? "Suspending the session and saving the snapshot…" : "Saving the snapshot…"}
          </span>
        ) : null}
        <Button type="button" variant="outline" onClick={onDone} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={submitDisabled}>
          {effectiveMode === "update" ? "Update snapshot" : "Save snapshot"}
        </Button>
      </DialogFooter>
    </form>
  );
}
