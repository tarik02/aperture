import { useState } from "react";
import { toast } from "sonner";
import { TenantCombobox } from "#/components/tenant-combobox.tsx";
import { apiClient } from "#/lib/api/client.ts";
import { selectAuth, useAuthSessionStore } from "#/stores/auth-session.ts";
import { cn } from "#/lib/utils.ts";

type SelectedTenantControlProps = {
  triggerClassName?: string;
  align?: "start" | "center" | "end";
};

export function SelectedTenantControl({
  triggerClassName,
  align = "end",
}: SelectedTenantControlProps) {
  const auth = useAuthSessionStore(selectAuth);
  const setAuthenticated = useAuthSessionStore((state) => state.setAuthenticated);
  const [switching, setSwitching] = useState(false);

  if (
    !auth ||
    (auth.principal.authorityType !== "system_admin" && auth.availableTenants.length === 0)
  ) {
    return null;
  }

  async function selectTenant(tenantId: string) {
    setSwitching(true);
    try {
      setAuthenticated(await apiClient.getAuthMe(tenantId));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Tenant switch failed");
    } finally {
      setSwitching(false);
    }
  }

  return (
    <TenantCombobox
      value={auth.selectedTenant?.id ?? null}
      selectedLabel={auth.selectedTenant?.displayName ?? null}
      onSelect={(tenant) => void selectTenant(tenant.id)}
      disabled={switching}
      placeholder="Tenant"
      triggerClassName={cn("h-7 max-w-56", triggerClassName)}
      align={align}
      options={
        auth.principal.type === "user" && auth.principal.authorityType !== "system_admin"
          ? auth.availableTenants
          : undefined
      }
    />
  );
}
