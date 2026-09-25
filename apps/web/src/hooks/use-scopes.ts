import { selectPrincipal, useAuthSessionStore } from "#/stores/auth-session.ts";

export function useActiveScopes(): readonly string[] {
  const principal = useAuthSessionStore(selectPrincipal);
  return principal?.scopes ?? [];
}

export function hasScope(scopes: readonly string[], required: string): boolean {
  if (scopes.includes("system:admin")) {
    return true;
  }
  return scopes.includes(required);
}

export function hasAllScopes(scopes: readonly string[], required: readonly string[]): boolean {
  return required.every((scope) => hasScope(scopes, scope));
}
