import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { SelectedTenantControl } from "#/components/selected-tenant-control.tsx";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { selectPrincipal, useAuthSessionStore } from "#/stores/auth-session.ts";

export function TenantRequiredNotice() {
  const credentials = useApiCredentials();
  const principal = useAuthSessionStore(selectPrincipal);

  if (!principal) {
    return null;
  }

  if (principal.authorityType === "tenant") {
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
