import { create } from "zustand";
import type { AuthMePrincipal, AuthMeResponse } from "#/lib/api/schemas.ts";

type AuthSessionData =
  | { status: "loading" | "unauthenticated"; auth: null }
  | { status: "authenticated"; auth: AuthMeResponse };

type AuthSessionState = AuthSessionData & {
  setAuthenticated: (response: AuthMeResponse) => void;
  setUnauthenticated: () => void;
};

export const useAuthSessionStore = create<AuthSessionState>((set) => ({
  status: "loading",
  auth: null,
  setAuthenticated: (response) => set({ status: "authenticated", auth: response }),
  setUnauthenticated: () => set({ status: "unauthenticated", auth: null }),
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
