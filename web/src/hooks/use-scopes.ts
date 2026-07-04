import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

export function useActiveScopes(): string[] {
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  return activeProfile?.scopes ?? [];
}

export function hasScope(scopes: string[], required: string): boolean {
  if (scopes.includes("system:admin")) {
    return true;
  }
  return scopes.includes(required);
}

export function hasAllScopes(scopes: string[], required: string[]): boolean {
  return required.every((scope) => hasScope(scopes, scope));
}
