import { useEffect, useState } from "react";
import { toast } from "sonner";
import { TenantCombobox } from "#/components/tenant-combobox.tsx";
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group.tsx";
import { useUpsertTenantMembershipMutation } from "#/features/user/user.mutations.ts";
import type { TenantMembership } from "#/lib/api/schemas.ts";
import { tenantScopeOptions } from "#/lib/scopes.ts";

type MembershipDialogProps = {
  open: boolean;
  userId: string;
  membership?: TenantMembership | null;
  tenantLabel?: string | null;
  existingTenantIds: string[];
  onOpenChange: (open: boolean) => void;
};

export function MembershipDialog({
  open,
  userId,
  membership = null,
  tenantLabel = null,
  existingTenantIds,
  onOpenChange,
}: MembershipDialogProps) {
  const mutation = useUpsertTenantMembershipMutation();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [selectedTenantLabel, setSelectedTenantLabel] = useState<string | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTenantId(membership?.tenantId ?? null);
    setSelectedTenantLabel(tenantLabel);
    setScopes(membership?.scopes ?? []);
    setTenantError(null);
    setScopeError(null);
  }, [membership, open, tenantLabel]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenantId) {
      setTenantError("Select a tenant");
      return;
    }
    if (!membership && existingTenantIds.includes(tenantId)) {
      setTenantError("This user already has access to that tenant");
      return;
    }
    if (scopes.length === 0) {
      setScopeError("Select at least one permission");
      return;
    }

    await mutation.mutateAsync({ userId, tenantId, scopes });
    toast.success(membership ? "Tenant access updated" : "Tenant access added");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>{membership ? "Edit tenant access" : "Add tenant access"}</DialogTitle>
            <DialogDescription>Choose what this user can do within one tenant.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-2">
            <Field data-invalid={tenantError ? true : undefined}>
              <FieldLabel>Tenant</FieldLabel>
              {membership ? (
                <Input value={tenantLabel ?? membership.tenantId} disabled />
              ) : (
                <TenantCombobox
                  value={tenantId}
                  selectedLabel={selectedTenantLabel}
                  onSelect={(tenant) => {
                    setTenantId(tenant.id);
                    setSelectedTenantLabel(tenant.displayName);
                    setTenantError(null);
                  }}
                  disabled={mutation.isPending}
                  align="start"
                  triggerClassName="w-full"
                />
              )}
              <FieldError>{tenantError}</FieldError>
            </Field>
            <FieldSet data-invalid={scopeError ? true : undefined}>
              <FieldLegend variant="label">Permissions</FieldLegend>
              <FieldDescription>Use the smallest set the user needs.</FieldDescription>
              <ToggleGroup
                multiple
                variant="outline"
                size="sm"
                value={scopes}
                onValueChange={(nextScopes) => {
                  setScopes(nextScopes);
                  setScopeError(null);
                }}
                disabled={mutation.isPending}
                className="flex w-full flex-wrap justify-start"
              >
                {tenantScopeOptions.map((scope) => (
                  <ToggleGroupItem key={scope.value} value={scope.value}>
                    {scope.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldError>{scopeError}</FieldError>
            </FieldSet>
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
              {mutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
