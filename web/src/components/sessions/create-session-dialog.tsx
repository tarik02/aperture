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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { TagEditor, entriesToTags, type TagEntry } from "#/components/resources/tag-editor.tsx";
import { useBrowserChannelsQuery } from "#/hooks/queries/use-browser-channels-query.ts";
import { useSnapshotsInfiniteQuery } from "#/hooks/queries/use-snapshots-query.ts";
import { useCreateSessionMutation } from "#/hooks/mutations/use-session-mutations.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import type { CreateSessionResponse } from "#/lib/api/schemas.ts";

const NO_SNAPSHOT = "__none__";

type CreateSessionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (result: CreateSessionResponse) => void;
};

export function CreateSessionDialog({ open, onOpenChange, onCreated }: CreateSessionDialogProps) {
  const channelsQuery = useBrowserChannelsQuery();
  const snapshotsQuery = useSnapshotsInfiniteQuery({ limit: 100 });
  const mutation = useCreateSessionMutation();

  const [channel, setChannel] = useState("");
  const [baseSnapshot, setBaseSnapshot] = useState<string | null>(null);
  const [browserArgs, setBrowserArgs] = useState("");
  const [tagEntries, setTagEntries] = useState<TagEntry[]>([]);
  const [channelError, setChannelError] = useState<string | null>(null);

  const snapshots = flattenInfinitePages(snapshotsQuery.data?.pages);
  const channels = channelsQuery.data?.channels ?? [];

  useEffect(() => {
    if (open && channels.length > 0 && !channel) {
      setChannel(channels[0]?.name ?? "");
    }
  }, [open, channels, channel]);

  useEffect(() => {
    if (!open) {
      setChannel("");
      setBaseSnapshot(null);
      setBrowserArgs("");
      setTagEntries([]);
      setChannelError(null);
    }
  }, [open]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!channel) {
      setChannelError("Channel required");
      return;
    }

    setChannelError(null);

    const args = browserArgs
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

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
      <DialogContent className="max-w-md">
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>Create session</DialogTitle>
          </DialogHeader>
          <FieldGroup className="py-2">
            <Field data-invalid={channelError ? true : undefined}>
              <FieldLabel>Channel</FieldLabel>
              <Select
                value={channel}
                onValueChange={(value) => setChannel(value ?? "")}
                disabled={mutation.isPending || channelsQuery.isLoading}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Channel" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError>{channelError}</FieldError>
            </Field>
            <Field>
              <FieldLabel>Base snapshot</FieldLabel>
              <Select
                value={baseSnapshot ?? NO_SNAPSHOT}
                onValueChange={(value) =>
                  setBaseSnapshot(value === NO_SNAPSHOT ? null : (value ?? null))
                }
                disabled={mutation.isPending}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SNAPSHOT}>None</SelectItem>
                  {snapshots.map((snapshot) => (
                    <SelectItem key={snapshot.id} value={snapshot.name}>
                      {snapshot.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="browser-args">Browser args</FieldLabel>
              <Textarea
                id="browser-args"
                value={browserArgs}
                onChange={(event) => setBrowserArgs(event.target.value)}
                placeholder="One arg per line"
                disabled={mutation.isPending}
              />
            </Field>
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
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
