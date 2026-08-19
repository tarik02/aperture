import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { useCreateUserMutation, useUpdateUserMutation } from "#/features/user/user.mutations.ts";
import type { User } from "#/lib/api/schemas.ts";

type UserFormDialogProps = {
  open: boolean;
  user?: User | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (user: User) => void;
};

export function UserFormDialog({ open, user = null, onOpenChange, onSaved }: UserFormDialogProps) {
  const createMutation = useCreateUserMutation();
  const updateMutation = useUpdateUserMutation();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [isSystemAdmin, setIsSystemAdmin] = useState(false);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const pending = createMutation.isPending || updateMutation.isPending;
  const mode = user ? "edit" : "create";

  useEffect(() => {
    if (!open) {
      return;
    }
    setDisplayName(user?.displayName ?? "");
    setEmail(user?.email ?? "");
    setIsSystemAdmin(user?.isSystemAdmin ?? false);
    setDisplayNameError(null);
  }, [open, user]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedDisplayName = displayName.trim();
    if (!trimmedDisplayName) {
      setDisplayNameError("Display name required");
      return;
    }

    const input = {
      displayName: trimmedDisplayName,
      email: email.trim() || null,
      isSystemAdmin,
    };
    const savedUser = user
      ? await updateMutation.mutateAsync({ userId: user.id, input })
      : await createMutation.mutateAsync(input);

    toast.success(user ? "User updated" : "User created");
    onSaved(savedUser);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>{mode === "create" ? "Create user" : "Edit user"}</DialogTitle>
            <DialogDescription>
              {mode === "create"
                ? "Add an account and assign deployment access."
                : "Update account details and deployment access."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-2">
            <Field data-invalid={displayNameError ? true : undefined}>
              <FieldLabel htmlFor="user-display-name">Display name</FieldLabel>
              <Input
                id="user-display-name"
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  setDisplayNameError(null);
                }}
                aria-invalid={displayNameError ? true : undefined}
                disabled={pending}
                autoFocus
              />
              <FieldError>{displayNameError}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="user-email">Email</FieldLabel>
              <Input
                id="user-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={pending}
                placeholder="name@example.com"
              />
              <FieldDescription>
                Optional when the account does not sign in by email.
              </FieldDescription>
            </Field>
            <Field orientation="horizontal" data-disabled={pending ? true : undefined}>
              <FieldContent>
                <FieldTitle>System administrator</FieldTitle>
                <FieldDescription>Full access across every tenant.</FieldDescription>
              </FieldContent>
              <Switch
                checked={isSystemAdmin}
                onCheckedChange={setIsSystemAdmin}
                disabled={pending}
                aria-label="System administrator"
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : mode === "create" ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
