import { create } from "zustand";
import type { DraftTagEntry } from "#/features/session/form/session-form.store.ts";

export type TagFormMode = "edit" | "apply";

type TagFormData = {
  resourceKey: string | null;
  entries: DraftTagEntry[];
  submitting: boolean;
};

type TagFormState = {
  mode: TagFormMode;
  formData: TagFormData;
  initForm: (mode: TagFormMode, resourceKey: string, entries: DraftTagEntry[]) => void;
  setFormData: (patch: Partial<TagFormData>) => void;
};

const defaultFormData: TagFormData = {
  resourceKey: null,
  entries: [],
  submitting: false,
};

export const useTagFormStore = create<TagFormState>()((set) => ({
  mode: "edit",
  formData: defaultFormData,
  initForm: (mode, resourceKey, entries) =>
    set({ mode, formData: { resourceKey, entries, submitting: false } }),
  setFormData: (patch) => set((state) => ({ formData: { ...state.formData, ...patch } })),
}));
