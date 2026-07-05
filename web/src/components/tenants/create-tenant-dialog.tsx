import { useEffect } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useCreateTenantMutation } from "#/hooks/mutations/use-tenant-mutations.ts";
import { useFormDraftStore } from "#/stores/form-drafts.ts";

type CreateTenantDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CreateTenantDialog({ open, onOpenChange }: CreateTenantDialogProps) {
  const mutation = useCreateTenantMutation();
  const displayName = useFormDraftStore((state) => state.createTenant.displayName);
  const error = useFormDraftStore((state) => state.createTenant.error);
  const setCreateTenant = useFormDraftStore((state) => state.setCreateTenant);
  const resetCreateTenant = useFormDraftStore((state) => state.resetCreateTenant);

  useEffect(() => {
    if (open) {
      resetCreateTenant();
    }
  }, [open, resetCreateTenant]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed) {
      setCreateTenant({ error: "Name required" });
      return;
    }

    setCreateTenant({ error: null });
    await mutation.mutateAsync({ displayName: trimmed });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>Create tenant</DialogTitle>
          </DialogHeader>
          <FieldGroup className="py-2">
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="tenant-name">Display name</FieldLabel>
              <Input
                id="tenant-name"
                value={displayName}
                onChange={(event) => setCreateTenant({ displayName: event.target.value })}
                disabled={mutation.isPending}
              />
              <FieldError>{error}</FieldError>
            </Field>
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
