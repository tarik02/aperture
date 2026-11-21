import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Input } from "@aperture-browser/ui/components/input";
import { type FormEvent, useState } from "react";
import { useTakeSnapshotMutation } from "#/features/snapshot/snapshot.mutations.ts";

type SaveSnapshotDialogProps = {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Keeps a session's profile as it is now, under a name. */
export function SaveSnapshotDialog({ sessionId, open, onOpenChange }: SaveSnapshotDialogProps) {
  const take = useTakeSnapshotMutation();
  const [name, setName] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    take.mutate(
      { sessionId, name: name.trim() === "" ? undefined : name.trim() },
      {
        onSuccess: () => {
          setName("");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form data-console-save-snapshot onSubmit={submit} className="aperture:grid aperture:gap-4">
          <DialogHeader>
            <DialogTitle>Save to snapshot</DialogTitle>
            <DialogDescription>
              The session's profile as it is now: its cookies, storage and extensions. New sessions
              start from it.
            </DialogDescription>
          </DialogHeader>
          <Input
            name="name"
            autoFocus
            placeholder="Name (optional)"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={take.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
