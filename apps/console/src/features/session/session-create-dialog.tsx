import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Input } from "@aperture-browser/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@aperture-browser/ui/components/native-select";
import {
  entriesToTags,
  TagEditor,
  type TagEntry,
} from "@aperture-browser/ui/components/tag-editor";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aperture-browser/ui/components/tabs";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { emptyDraft, ProxyEditor, proxyOf } from "#/features/proxy/proxy-editor.tsx";
import { useCreateSessionMutation } from "#/features/session/session.mutations.ts";
import { useSnapshotsQuery } from "#/features/snapshot/snapshot.queries.ts";

type SessionCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** A session made as it is asked for: named, from a snapshot, routed, tagged. */
export function SessionCreateDialog({ open, onOpenChange }: SessionCreateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? <CreateForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const snapshots = useSnapshotsQuery();
  const create = useCreateSessionMutation();
  const [label, setLabel] = useState("");
  const [snapshotId, setSnapshotId] = useState("");
  const [proxy, setProxy] = useState(emptyDraft);
  const [tags, setTags] = useState<TagEntry[]>([]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const routed = proxyOf(proxy);
    create.mutate(
      {
        ...(label.trim() === "" ? {} : { label: label.trim() }),
        ...(snapshotId === "" ? {} : { snapshotId }),
        ...(routed === null ? {} : { proxy: routed }),
        tags: entriesToTags(tags),
      },
      {
        onSuccess: (session) => {
          onDone();
          void navigate({ to: "/-/sessions/$sessionId", params: { sessionId: session.id } });
        },
      },
    );
  };

  return (
    <form data-console-session-create onSubmit={submit} className="aperture:grid aperture:gap-4">
      <DialogHeader>
        <DialogTitle>New session</DialogTitle>
      </DialogHeader>
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="proxy">Routing</TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="aperture:grid aperture:gap-4 aperture:pt-2">
          <label className="aperture:grid aperture:gap-1.5 aperture:text-sm">
            Label
            <Input
              name="label"
              autoFocus
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label className="aperture:grid aperture:gap-1.5 aperture:text-sm">
            Start from
            <NativeSelect
              name="snapshot"
              value={snapshotId}
              onChange={(event) => setSnapshotId(event.target.value)}
            >
              <NativeSelectOption value="">An empty profile</NativeSelectOption>
              {snapshots.data?.map((snapshot) => (
                <NativeSelectOption key={snapshot.id} value={snapshot.id}>
                  {snapshot.name ?? snapshot.id}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        </TabsContent>
        <TabsContent value="proxy" className="aperture:pt-2">
          <ProxyEditor draft={proxy} onChange={setProxy} />
        </TabsContent>
        <TabsContent value="advanced" className="aperture:pt-2">
          <TagEditor entries={tags} onChange={setTags} />
        </TabsContent>
      </Tabs>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
