import { selectAuth, useAuthSessionStore } from "#/stores/auth-session.ts";

/**
 * Display name of a tenant the signed-in principal works in: the selected one
 * or one of its memberships. `null` when the name is not known here.
 */
export function useTenantName(tenantId: string | null | undefined): string | null {
  const auth = useAuthSessionStore(selectAuth);
  if (!tenantId || !auth) {
    return null;
  }
  if (auth.selectedTenant?.id === tenantId) {
    return auth.selectedTenant.displayName;
  }
  return auth.availableTenants.find((tenant) => tenant.id === tenantId)?.displayName ?? null;
}
