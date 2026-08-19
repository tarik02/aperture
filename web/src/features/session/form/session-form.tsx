import { useMemo } from "react";
import { Button } from "#/components/ui/button.tsx";
import { DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "#/components/ui/combobox.tsx";
import { TagEditor, entriesToTags } from "#/components/resources/tag-editor.tsx";
import { BrowserArgsEditor } from "#/components/sessions/browser-args-editor.tsx";
import { useCreateSessionMutation } from "#/features/session/session.mutations.ts";
import { useBrowserConfigurationsQuery } from "#/features/browser/browser.queries.ts";
import { useSnapshotsInfiniteQuery } from "#/features/snapshot/snapshot.queries.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import type { CreateSessionResponse } from "#/lib/api/schemas.ts";
import { cn } from "#/lib/utils.ts";
import { useSessionCreateModalStore } from "#/features/session/create-modal/session-create-modal.store.ts";
import { useSessionFormStore } from "#/features/session/form/session-form.store.ts";

type SessionFormProps = {
  onCreated?: (result: CreateSessionResponse) => void;
};

export function SessionForm({ onCreated }: SessionFormProps) {
  const configurationsQuery = useBrowserConfigurationsQuery();
  const snapshotsQuery = useSnapshotsInfiniteQuery({ limit: 100 });
  const mutation = useCreateSessionMutation();

  const draft = useSessionFormStore((state) => state.formData);
  const setFormData = useSessionFormStore((state) => state.setFormData);
  const closeModal = useSessionCreateModalStore((state) => state.closeModal);
  const { label, channel, browserMode, baseSnapshot, browserArgs, tagEntries, channelError } =
    draft;

  const snapshots = flattenInfinitePages(snapshotsQuery.data?.pages);
  const configurations = configurationsQuery.data?.configurations ?? [];
  const channels = useMemo(
    () => Array.from(new Set(configurations.map((configuration) => configuration.channel))),
    [configurations],
  );
  const selectedChannel = channel || channels[0] || "";
  const modes = configurations.filter((configuration) => configuration.channel === selectedChannel);
  const selectedMode = modes.some((configuration) => configuration.mode === browserMode)
    ? browserMode
    : modes[0]?.mode;
  const channelOptions = useMemo(
    () => channels.map((item) => ({ value: item, label: item })),
    [channels],
  );
  const modeOptions = modes.map((configuration) => ({
    value: configuration.mode,
    label: configuration.mode === "headed" ? "Headed" : "Headless",
  }));
  const snapshotNames = useMemo(() => snapshots.map((snapshot) => snapshot.name), [snapshots]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!selectedChannel || !selectedMode) {
      setFormData({ channelError: "Browser configuration required" });
      return;
    }

    setFormData({ channelError: null });

    const args = browserArgs.map((line) => line.trim()).filter(Boolean);

    const result = await mutation.mutateAsync({
      browser: { channel: selectedChannel, mode: selectedMode, args },
      baseSnapshotName: baseSnapshot,
      label: label.trim() || null,
      tags: entriesToTags(tagEntries),
    });

    onCreated?.(result);
    closeModal();
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <DialogHeader>
        <DialogTitle>Create session</DialogTitle>
      </DialogHeader>
      <FieldGroup className="py-2">
        <Field>
          <FieldLabel>Label</FieldLabel>
          <Input
            value={label}
            onChange={(event) => setFormData({ label: event.target.value })}
            placeholder="Optional"
            disabled={mutation.isPending}
          />
        </Field>
        <Field data-invalid={channelError ? true : undefined}>
          <FieldLabel>Channel</FieldLabel>
          <Select
            items={channelOptions}
            value={selectedChannel}
            onValueChange={(value) => {
              const nextChannel = value ?? "";
              const nextMode = configurations.find(
                (configuration) => configuration.channel === nextChannel,
              )?.mode;
              setFormData({
                channel: nextChannel,
                browserMode: nextMode ?? browserMode,
              });
            }}
            disabled={mutation.isPending || configurationsQuery.isLoading}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Channel" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {channels.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldError>{channelError}</FieldError>
        </Field>
        <Field>
          <FieldLabel>Mode</FieldLabel>
          <Select
            items={modeOptions}
            value={selectedMode}
            onValueChange={(value) => {
              if (value === "headed" || value === "headless") {
                setFormData({ browserMode: value });
              }
            }}
            disabled={mutation.isPending || configurationsQuery.isLoading || modes.length < 2}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {modes.map((configuration) => (
                  <SelectItem key={configuration.mode} value={configuration.mode}>
                    {configuration.mode === "headed" ? "Headed" : "Headless"}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>Base snapshot</FieldLabel>
          <Combobox
            items={snapshotNames}
            value={baseSnapshot}
            onValueChange={(value) =>
              setFormData({ baseSnapshot: typeof value === "string" ? value : null })
            }
          >
            <ComboboxTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  className="w-full min-w-0 justify-between"
                  disabled={mutation.isPending}
                />
              }
            >
              <span className={cn("min-w-0 truncate", !baseSnapshot && "text-muted-foreground")}>
                {baseSnapshot ?? "None"}
              </span>
            </ComboboxTrigger>
            <ComboboxContent align="start" className="w-(--anchor-width)">
              <ComboboxInput
                placeholder="Search snapshots"
                showTrigger={false}
                className="w-auto"
              />
              {baseSnapshot ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mx-1 mt-1 justify-start"
                  onClick={() => setFormData({ baseSnapshot: null })}
                >
                  No base snapshot
                </Button>
              ) : null}
              <ComboboxEmpty>No snapshots found</ComboboxEmpty>
              <ComboboxList>
                {(snapshotName: string) => (
                  <ComboboxItem key={snapshotName} value={snapshotName}>
                    {snapshotName}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </Field>
        <BrowserArgsEditor
          args={browserArgs}
          onChange={(args) => setFormData({ browserArgs: args })}
          disabled={mutation.isPending}
        />
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
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
