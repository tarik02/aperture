import { TenantCombobox } from "#/components/tenant-combobox.tsx";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";
import { cn } from "#/lib/utils.ts";

type SelectedTenantControlProps = {
  triggerClassName?: string;
  align?: "start" | "center" | "end";
};

export function SelectedTenantControl({
  triggerClassName,
  align = "end",
}: SelectedTenantControlProps) {
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const setSelectedTenant = useTokenVaultStore((state) => state.setSelectedTenant);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);

  if (!activeProfile || activeProfile.authorityType !== "system_admin") {
    return null;
  }

  const profileId = activeProfile.id;

  return (
    <TenantCombobox
      value={activeProfile.selectedTenantId}
      selectedLabel={activeProfile.selectedTenantDisplayName}
      onSelect={(tenant) => setSelectedTenant(profileId, tenant.id, tenant.displayName)}
      disabled={bootstrapping}
      placeholder="Tenant"
      triggerClassName={cn("h-7 max-w-56", triggerClassName)}
      align={align}
    />
  );
}
