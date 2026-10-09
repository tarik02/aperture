import { create } from "zustand";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { toast } from "sonner";
import type { AuthMePrincipal, AuthMeResponse } from "@aperture-browser/api-client";

const temporaryTenantKey = "aperture-temporary-tenant";
const temporaryTenantSchema = Schema.fromJsonString(
  Schema.Struct({
    principalId: Schema.String,
    principalType: Schema.String,
    tenantId: Schema.String,
  }),
);

export function readTemporaryTenant(principal: AuthMePrincipal): string | null {
  try {
    const stored = Option.getOrNull(
      Schema.decodeUnknownOption(temporaryTenantSchema)(sessionStorage.getItem(temporaryTenantKey)),
    );
    return stored?.principalId === principal.id && stored.principalType === principal.type
      ? stored.tenantId
      : null;
  } catch {
    // Storage can be disabled; the override still works until this page is refreshed.
    return null;
  }
}

function clearTemporaryTenant() {
  try {
    sessionStorage.removeItem(temporaryTenantKey);
  } catch {
    // The in-memory selection is cleared even when browser storage is unavailable.
  }
}

type AuthSessionData =
  | { status: "loading" | "unauthenticated"; auth: null }
  | { status: "authenticated"; auth: AuthMeResponse };

type AuthSessionState = AuthSessionData & {
  isTemporaryTenant: boolean;
  setAuthenticated: (response: AuthMeResponse) => void;
  setTemporaryAuthenticated: (response: AuthMeResponse) => void;
  setUnauthenticated: () => void;
};

export const useAuthSessionStore = create<AuthSessionState>((set) => ({
  status: "loading",
  auth: null,
  isTemporaryTenant: false,
  setAuthenticated: (response) => {
    clearTemporaryTenant();
    set({ status: "authenticated", auth: response, isTemporaryTenant: false });
  },
  setTemporaryAuthenticated: (response) => {
    if (response.selectedTenant === null) {
      return;
    }
    try {
      sessionStorage.setItem(
        temporaryTenantKey,
        Schema.encodeSync(temporaryTenantSchema)({
          principalId: response.principal.id,
          principalType: response.principal.type,
          tenantId: response.selectedTenant.id,
        }),
      );
    } catch {
      toast.warning("Temporary tenant is active, but it cannot be saved for refresh.");
    }
    set({ status: "authenticated", auth: response, isTemporaryTenant: true });
  },
  setUnauthenticated: () => {
    clearTemporaryTenant();
    set({ status: "unauthenticated", auth: null, isTemporaryTenant: false });
  },
}));

export function selectAuth(state: AuthSessionState): AuthMeResponse | null {
  return state.auth;
}

export function selectPrincipal(state: AuthSessionState): AuthMePrincipal | null {
  return state.auth?.principal ?? null;
}

export function selectIsSystemAdmin(state: AuthSessionState): boolean {
  return state.auth?.principal.authorityType === "system_admin";
}
