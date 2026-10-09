import { TenantCombobox } from "#/components/tenant-combobox.tsx";
import { selectAuth, useAuthSessionStore } from "#/stores/auth-session.ts";
import { cn } from "@aperture-browser/ui/utils";
import { Button } from "@aperture-browser/ui/components/button";
import { useTenantSelection } from "#/hooks/use-tenant-selection.ts";

interface SelectedTenantControlProps {
  triggerClassName?: string;
  align?: "start" | "center" | "end";
}

export function SelectedTenantControl({
  triggerClassName,
  align = "end",
}: SelectedTenantControlProps) {
  const auth = useAuthSessionStore(selectAuth);
  const isTemporaryTenant = useAuthSessionStore((state) => state.isTemporaryTenant);
  const { selectTenant, switching } = useTenantSelection();

  if (
    !auth ||
    (auth.principal.authorityType !== "system_admin" && auth.availableTenants.length === 0)
  ) {
    return null;
  }

  return (
    <div className="aperture:flex aperture:min-w-0 aperture:flex-col aperture:gap-1">
      <TenantCombobox
        value={auth.selectedTenant?.id ?? null}
        selectedLabel={
          auth.selectedTenant === null
            ? null
            : `${auth.selectedTenant.displayName}${isTemporaryTenant ? " · temporary" : ""}`
        }
        onSelect={(tenant) => void selectTenant(tenant.id, isTemporaryTenant)}
        disabled={switching}
        placeholder="Tenant"
        triggerClassName={cn("aperture:h-7 aperture:max-w-56", triggerClassName)}
        align={align}
        options={
          auth.principal.type === "user" && auth.principal.authorityType !== "system_admin"
            ? auth.availableTenants
            : undefined
        }
      />
      {isTemporaryTenant ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={switching}
          onClick={() => void selectTenant(null, true)}
          className="aperture:group-data-[collapsible=icon]:hidden"
        >
          Return to remembered tenant
        </Button>
      ) : null}
    </div>
  );
}
