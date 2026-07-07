import { create } from "zustand";

export type TokenFormMode = "add" | "welcome";

type TokenFormData = {
  rawToken: string;
  tokenError: string | null;
  submitting: boolean;
};

type TokenFormState = {
  mode: TokenFormMode;
  formData: TokenFormData;
  initForm: (mode: TokenFormMode) => void;
  setFormData: (patch: Partial<TokenFormData>) => void;
};

const defaultFormData: TokenFormData = {
  rawToken: "",
  tokenError: null,
  submitting: false,
};

export const useTokenFormStore = create<TokenFormState>()((set) => ({
  mode: "add",
  formData: defaultFormData,
  initForm: (mode) => set({ mode, formData: defaultFormData }),
  setFormData: (patch) => set((state) => ({ formData: { ...state.formData, ...patch } })),
}));
