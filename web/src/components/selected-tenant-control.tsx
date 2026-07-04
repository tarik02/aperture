import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldError, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "#/components/ui/popover.tsx";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

export function SelectedTenantControl() {
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const setSelectedTenant = useTokenVaultStore((state) => state.setSelectedTenant);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);

  const [tenantId, setTenantId] = useState(activeProfile?.selectedTenantId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setTenantId(activeProfile?.selectedTenantId ?? "");
  }, [activeProfile?.id, activeProfile?.selectedTenantId]);

  if (!activeProfile || activeProfile.authorityType !== "system_admin") {
    return null;
  }

  const profileId = activeProfile.id;
  const displayLabel =
    activeProfile.selectedTenantDisplayName ?? activeProfile.selectedTenantId ?? "Tenant";

  function handleApply() {
    const trimmedTenantId = tenantId.trim();
    if (!trimmedTenantId) {
      setError("Tenant ID required");
      return;
    }

    setError(null);
    setSelectedTenant(profileId, trimmedTenantId);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="hidden h-7 gap-1.5 sm:inline-flex" />
        }
      >
        <Building2 className="size-3.5" />
        <span className="max-w-32 truncate">{displayLabel}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <PopoverHeader>
          <PopoverTitle>Tenant</PopoverTitle>
        </PopoverHeader>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="selected-tenant-id">Tenant ID</FieldLabel>
          <Input
            id="selected-tenant-id"
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            aria-invalid={error ? true : undefined}
            disabled={bootstrapping}
          />
          <FieldError>{error}</FieldError>
        </Field>
        <Button size="sm" className="w-full" onClick={handleApply} disabled={bootstrapping}>
          Apply
        </Button>
      </PopoverContent>
    </Popover>
  );
}
