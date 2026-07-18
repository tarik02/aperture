import { create } from "zustand";
import type { CreateTokenResponse, ResourceGrant, ResourceMode } from "#/lib/api/schemas.ts";

type TokenCreateFormData = {
  name: string;
  authorityType: "system_admin" | "tenant";
  tenantId: string;
  scopes: string[];
  resourceMode: ResourceMode;
  resourceGrants: ResourceGrant[];
  expiresAt: string;
  nameError: string | null;
  scopeError: string | null;
  resourceGrantError: string | null;
  createdToken: CreateTokenResponse | null;
};

type TokenCreateFormState = {
  mode: "create";
  formData: TokenCreateFormData;
  initForm: (tenantId: string, resourceMode: ResourceMode) => void;
  setFormData: (patch: Partial<TokenCreateFormData>) => void;
  toggleScope: (scope: string) => void;
};

const defaultFormData = (tenantId: string, resourceMode: ResourceMode): TokenCreateFormData => ({
  name: "",
  authorityType: "tenant",
  tenantId,
  scopes: ["sessions:read", "sessions:write"],
  resourceMode,
  resourceGrants: [],
  expiresAt: "",
  nameError: null,
  scopeError: null,
  resourceGrantError: null,
  createdToken: null,
});

export const useTokenCreateFormStore = create<TokenCreateFormState>()((set) => ({
  mode: "create",
  formData: defaultFormData("", "all"),
  initForm: (tenantId, resourceMode) => set({ formData: defaultFormData(tenantId, resourceMode) }),
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
