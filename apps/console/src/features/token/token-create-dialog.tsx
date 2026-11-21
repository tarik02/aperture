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
import { type FormEvent, useState } from "react";
import { useCreateTokenMutation } from "#/features/token/token.queries.ts";

const EXPIRY = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "Never", days: undefined },
] as const;

type TokenCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hears the secret, the one time it is told. */
  onCreated: (secret: string) => void;
};

export function TokenCreateDialog({ open, onOpenChange, onCreated }: TokenCreateDialogProps) {
  const create = useCreateTokenMutation();
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("30 days");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), expiresInDays: EXPIRY.find((one) => one.label === expiry)?.days },
      {
        onSuccess: (made) => {
          setName("");
          onOpenChange(false);
          onCreated(made.token);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form data-console-token-create onSubmit={submit} className="aperture:grid aperture:gap-4">
          <DialogHeader>
            <DialogTitle>New API token</DialogTitle>
          </DialogHeader>
          <label className="aperture:grid aperture:gap-1.5 aperture:text-sm">
            Name
            <Input
              name="name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="aperture:grid aperture:gap-1.5 aperture:text-sm">
            Expires
            <NativeSelect value={expiry} onChange={(event) => setExpiry(event.target.value)}>
              {EXPIRY.map((one) => (
                <NativeSelectOption key={one.label} value={one.label}>
                  {one.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || name.trim() === ""}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
