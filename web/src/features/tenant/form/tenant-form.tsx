import { Button } from "#/components/ui/button.tsx";
import { DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import {
  useCreateTenantMutation,
  useUpdateTenantMutation,
} from "#/features/tenant/tenant.mutations.ts";
import {
  useTenantFormStore,
  type TenantFormMode,
} from "#/features/tenant/form/tenant-form.store.ts";

type TenantFormProps = {
  mode: TenantFormMode;
  onDone: () => void;
};

export function TenantForm({ mode, onDone }: TenantFormProps) {
  const createMutation = useCreateTenantMutation();
  const updateMutation = useUpdateTenantMutation();
  const { tenantId, displayName, error } = useTenantFormStore((state) => state.formData);
  const setFormData = useTenantFormStore((state) => state.setFormData);
  const pending = createMutation.isPending || updateMutation.isPending;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed) {
      setFormData({ error: "Name required" });
      return;
    }

    setFormData({ error: null });
    if (mode === "create") {
      await createMutation.mutateAsync({ displayName: trimmed });
    } else {
      if (!tenantId) {
        return;
      }
      await updateMutation.mutateAsync({ tenantId, displayName: trimmed });
    }
    onDone();
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <DialogHeader>
        <DialogTitle>{mode === "create" ? "Create tenant" : "Rename tenant"}</DialogTitle>
      </DialogHeader>
      <FieldGroup className="py-2">
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="tenant-name">Display name</FieldLabel>
          <Input
            id="tenant-name"
            value={displayName}
            onChange={(event) => setFormData({ displayName: event.target.value })}
            disabled={pending}
          />
          <FieldError>{error}</FieldError>
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {mode === "create" ? "Create" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
