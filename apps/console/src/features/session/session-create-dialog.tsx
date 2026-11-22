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
  type TagEntry,
} from "@aperture-browser/ui/components/tag-editor";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aperture-browser/ui/components/tabs";
import { useForm, useStore } from "@tanstack/react-form";
import { useId, useState } from "react";
import { Choice } from "#/components/choice.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { TextField } from "#/components/text-field.tsx";
import { emptyDraft, ProxyEditor, proxyOf, proxyRules } from "#/features/proxy/proxy-editor.tsx";
import { useOpenNewSession } from "#/features/session/session.mutations.ts";
import { useSnapshotsQuery } from "#/features/snapshot/snapshot.queries.ts";
import { useSelectedWorkspace } from "#/features/workspace/workspace.queries.ts";

/** Stands for no snapshot where one is chosen. */
const EMPTY = "empty";

type SessionCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** A session made as it is asked for: named, from a snapshot, routed, tagged. */
export function SessionCreateDialog({ open, onOpenChange }: SessionCreateDialogProps) {
  return (
    <FreshDialog
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      className="aperture:sm:max-w-xl"
    >
      <CreateForm onDone={() => onOpenChange(false)} />
    </FreshDialog>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const snapshots = useSnapshotsQuery();
  const workspace = useSelectedWorkspace();
  const open = useOpenNewSession();
  const snapshotId = useId();
  const [tab, setTab] = useState("general");
  const form = useForm({
    defaultValues: {
      label: "",
      snapshotId: EMPTY,
      proxy: emptyDraft,
      tags: [] as TagEntry[],
    },
    onSubmit: ({ value }) => {
      const routed = proxyOf(value.proxy);
      onDone();
      void open({
        ...(value.label.trim() === "" ? {} : { label: value.label.trim() }),
        ...(value.snapshotId === EMPTY ? {} : { snapshotId: value.snapshotId }),
        ...(routed === null ? {} : { proxy: routed }),
        ...(workspace === null ? {} : { workspaceId: workspace.id }),
        tags: entriesToTags(value.tags),
      });
    },
    validators: {
      // Asked of the form, since the routing's tab may not be the one shown.
      onSubmit: ({ value }) => {
        const wrong = proxyRules(value.proxy);
        return wrong === undefined ? undefined : { fields: { proxy: wrong } };
      },
    },
    onSubmitInvalid: () => setTab("proxy"),
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const from = [
    { value: EMPTY, label: "An empty profile" },
    ...(snapshots.data ?? [])
      .filter((snapshot) => snapshot.workspaceId === (workspace?.id ?? null))
      .map((snapshot) => ({ value: snapshot.id, label: snapshot.name ?? snapshot.id })),
  ];

  return (
    <form
      data-console-session-create
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>New session</DialogTitle>
      </DialogHeader>
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(String(value))}
        className="aperture:min-h-0 aperture:flex-1 aperture:gap-4"
      >
        <TabsList className="aperture:shrink-0">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="proxy">Routing</TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>
        {/* The tallest of its tabs: the one of tags, with three of them. */}
        <DialogBody height="calc(0.75rem + 6 * var(--control-height))">
          <TabsContent
            value="general"
            className="aperture:grid aperture:content-start aperture:gap-4"
          >
            <form.Field name="label">
              {(field) => (
                <TextField
                  field={field}
                  label="Label"
                  placeholder="Optional"
                  autoFocus
                  autoComplete="off"
                />
              )}
            </form.Field>
            <form.Field name="snapshotId">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={snapshotId}>Start from</FieldLabel>
                  <Choice
                    id={snapshotId}
                    className="aperture:w-full"
                    value={field.state.value}
                    options={from}
                    onChange={field.handleChange}
                  />
                </Field>
              )}
            </form.Field>
          </TabsContent>
          <TabsContent value="proxy">
            <form.Field name="proxy">
              {(field) => (
                <ProxyEditor
                  draft={field.state.value}
                  error={
                    field.state.meta.errors.length > 0 ? proxyRules(field.state.value) : undefined
                  }
                  onChange={field.handleChange}
                />
              )}
            </form.Field>
          </TabsContent>
          <TabsContent value="advanced">
            <form.Field name="tags">
              {(field) => <TagEditor entries={field.state.value} onChange={field.handleChange} />}
            </form.Field>
          </TabsContent>
        </DialogBody>
      </Tabs>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={submitting}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
