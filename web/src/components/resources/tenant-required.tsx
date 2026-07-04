import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { SelectedTenantControl } from "#/components/selected-tenant-control.tsx";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

export function TenantRequiredNotice() {
  const credentials = useApiCredentials();
  const activeProfile = useTokenVaultStore(selectActiveProfile);

  if (!activeProfile) {
    return null;
  }

  if (activeProfile.authorityType === "tenant") {
    return null;
  }

  if (isTenantScopedQueryReady(credentials)) {
    return null;
  }

  return (
    <Alert>
      <AlertDescription className="flex items-center justify-between gap-3">
        <span>Select a tenant to view resources.</span>
        <SelectedTenantControl />
      </AlertDescription>
    </Alert>
  );
}
