import { create } from "zustand";
import type { CreateTokenResponse } from "#/lib/api/schemas.ts";

type TokenCreateFormData = {
  name: string;
  authorityType: "system_admin" | "tenant";
  tenantId: string;
  scopes: string[];
  expiresAt: string;
  nameError: string | null;
  scopeError: string | null;
  createdToken: CreateTokenResponse | null;
};

type TokenCreateFormState = {
  mode: "create";
  formData: TokenCreateFormData;
  initForm: (tenantId: string) => void;
  setFormData: (patch: Partial<TokenCreateFormData>) => void;
  toggleScope: (scope: string) => void;
};

const defaultFormData = (tenantId: string): TokenCreateFormData => ({
  name: "",
  authorityType: "tenant",
  tenantId,
  scopes: ["sessions:read", "sessions:write"],
  expiresAt: "",
  nameError: null,
  scopeError: null,
  createdToken: null,
});

export const useTokenCreateFormStore = create<TokenCreateFormState>()((set) => ({
  mode: "create",
  formData: defaultFormData(""),
  initForm: (tenantId) => set({ formData: defaultFormData(tenantId) }),
  setFormData: (patch) => set((state) => ({ formData: { ...state.formData, ...patch } })),
  toggleScope: (scope) =>
    set((state) => ({
      formData: {
        ...state.formData,
        scopes: state.formData.scopes.includes(scope)
          ? state.formData.scopes.filter((item) => item !== scope)
          : [...state.formData.scopes, scope],
      },
    })),
}));
