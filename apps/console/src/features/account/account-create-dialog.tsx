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
import { NativeSelect, NativeSelectOption } from "@aperture-browser/ui/components/native-select";
import { type FormEvent, useState } from "react";
import { useCreateAccountMutation } from "#/features/account/account.queries.ts";

type AccountCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** A new account: a person's, who signs in, or a service's, which comes with tokens. */
export function AccountCreateDialog({ open, onOpenChange }: AccountCreateDialogProps) {
  const create = useCreateAccountMutation();
  const [kind, setKind] = useState<"person" | "service">("person");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), ...(kind === "person" ? { email: email.trim() } : {}) },
      {
        onSuccess: () => {
          setName("");
          setEmail("");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          data-console-account-create
          onSubmit={submit}
          className="aperture:grid aperture:gap-4"
        >
          <DialogHeader>
            <DialogTitle>New account</DialogTitle>
            <DialogDescription>
              A person signs in once they set a password with a setup link. A service comes with API
              tokens alone.
            </DialogDescription>
          </DialogHeader>
          <NativeSelect
            aria-label="Kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as "person" | "service")}
          >
            <NativeSelectOption value="person">A person</NativeSelectOption>
            <NativeSelectOption value="service">A service</NativeSelectOption>
          </NativeSelect>
          <label className="aperture:grid aperture:gap-1.5 aperture:text-sm">
            Name
            <Input
              name="name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {kind === "person" ? (
            <label className="aperture:grid aperture:gap-1.5 aperture:text-sm">
              Email
              <Input
                type="email"
                name="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                create.isPending || name.trim() === "" || (kind === "person" && email.trim() === "")
              }
            >
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
