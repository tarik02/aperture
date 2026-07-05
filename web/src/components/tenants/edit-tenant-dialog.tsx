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
import { useUpdateTenantMutation } from "#/hooks/mutations/use-tenant-mutations.ts";
import type { Tenant } from "#/lib/api/schemas.ts";
import { useFormDraftStore } from "#/stores/form-drafts.ts";

type EditTenantDialogProps = {
  tenant: Tenant | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function EditTenantDialog({ tenant, open, onOpenChange }: EditTenantDialogProps) {
  const mutation = useUpdateTenantMutation();
  const displayName = useFormDraftStore((state) => state.editTenant.displayName);
  const error = useFormDraftStore((state) => state.editTenant.error);
  const setEditTenant = useFormDraftStore((state) => state.setEditTenant);
  const resetEditTenant = useFormDraftStore((state) => state.resetEditTenant);

  useEffect(() => {
    if (open && tenant) {
      resetEditTenant(tenant.id, tenant.displayName);
    }
  }, [open, tenant, resetEditTenant]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!tenant) {
      return;
    }

    const trimmed = displayName.trim();
    if (!trimmed) {
      setEditTenant({ error: "Name required" });
      return;
    }

    setEditTenant({ error: null });
    await mutation.mutateAsync({ tenantId: tenant.id, displayName: trimmed });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>Rename tenant</DialogTitle>
          </DialogHeader>
          <FieldGroup className="py-2">
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="edit-tenant-name">Display name</FieldLabel>
              <Input
                id="edit-tenant-name"
                value={displayName}
                onChange={(event) => setEditTenant({ displayName: event.target.value })}
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
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
