import { useEffect, useMemo } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
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
import { useBrowserChannelsQuery } from "#/hooks/queries/use-browser-channels-query.ts";
import { useSnapshotsInfiniteQuery } from "#/hooks/queries/use-snapshots-query.ts";
import { useCreateSessionMutation } from "#/hooks/mutations/use-session-mutations.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import type { CreateSessionResponse } from "#/lib/api/schemas.ts";
import { cn } from "#/lib/utils.ts";
import { useFormDraftStore } from "#/stores/form-drafts.ts";

type CreateSessionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (result: CreateSessionResponse) => void;
};

export function CreateSessionDialog({ open, onOpenChange, onCreated }: CreateSessionDialogProps) {
  const channelsQuery = useBrowserChannelsQuery();
  const snapshotsQuery = useSnapshotsInfiniteQuery({ limit: 100 });
  const mutation = useCreateSessionMutation();

  const draft = useFormDraftStore((state) => state.createSession);
  const setCreateSession = useFormDraftStore((state) => state.setCreateSession);
  const resetCreateSession = useFormDraftStore((state) => state.resetCreateSession);
  const { channel, baseSnapshot, browserArgs, tagEntries, channelError } = draft;

  const snapshots = flattenInfinitePages(snapshotsQuery.data?.pages);
  const channels = channelsQuery.data?.channels ?? [];
  const channelOptions = useMemo(
    () => channels.map((item) => ({ value: item.name, label: item.name })),
    [channels],
  );
  const snapshotNames = useMemo(() => snapshots.map((snapshot) => snapshot.name), [snapshots]);

  useEffect(() => {
    if (open) {
      resetCreateSession();
    }
  }, [open, resetCreateSession]);

  useEffect(() => {
    if (open && channels.length > 0 && !channel) {
      setCreateSession({ channel: channels[0]?.name ?? "" });
    }
  }, [open, channels, channel, setCreateSession]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!channel) {
      setCreateSession({ channelError: "Channel required" });
      return;
    }

    setCreateSession({ channelError: null });

    const args = browserArgs.map((line) => line.trim()).filter(Boolean);

    const result = await mutation.mutateAsync({
      browser: { channel, args },
      baseSnapshotName: baseSnapshot,
      tags: entriesToTags(tagEntries),
    });

    onCreated?.(result);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>Create session</DialogTitle>
          </DialogHeader>
          <FieldGroup className="py-2">
            <Field data-invalid={channelError ? true : undefined}>
              <FieldLabel>Channel</FieldLabel>
              <Select
                items={channelOptions}
                value={channel}
                onValueChange={(value) => setCreateSession({ channel: value ?? "" })}
                disabled={mutation.isPending || channelsQuery.isLoading}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Channel" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {channels.map((item) => (
                      <SelectItem key={item.name} value={item.name}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldError>{channelError}</FieldError>
            </Field>
            <Field>
              <FieldLabel>Base snapshot</FieldLabel>
              <Combobox
                items={snapshotNames}
                value={baseSnapshot}
                onValueChange={(value) =>
                  setCreateSession({ baseSnapshot: typeof value === "string" ? value : null })
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
                  <span
                    className={cn("min-w-0 truncate", !baseSnapshot && "text-muted-foreground")}
                  >
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
                      onClick={() => setCreateSession({ baseSnapshot: null })}
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
              onChange={(args) => setCreateSession({ browserArgs: args })}
              disabled={mutation.isPending}
            />
            <TagEditor
              entries={tagEntries}
              onChange={(entries) => setCreateSession({ tagEntries: entries })}
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
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
