import { create } from "zustand";

export type TenantFormMode = "create" | "edit";

type TenantFormData = {
  tenantId: string | null;
  displayName: string;
  error: string | null;
};

type TenantFormState = {
  mode: TenantFormMode;
  formData: TenantFormData;
  initCreate: () => void;
  initEdit: (tenantId: string, displayName: string) => void;
  setFormData: (patch: Partial<TenantFormData>) => void;
};

const defaultFormData: TenantFormData = {
  tenantId: null,
  displayName: "",
  error: null,
};

export const useTenantFormStore = create<TenantFormState>()((set) => ({
  mode: "create",
  formData: defaultFormData,
  initCreate: () => set({ mode: "create", formData: defaultFormData }),
  initEdit: (tenantId, displayName) =>
    set({ mode: "edit", formData: { tenantId, displayName, error: null } }),
  setFormData: (patch) => set((state) => ({ formData: { ...state.formData, ...patch } })),
}));
