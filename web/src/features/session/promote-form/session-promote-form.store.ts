import { create } from "zustand";
import type { DraftTagEntry } from "#/features/session/form/session-form.store.ts";

type SessionPromoteFormData = {
  sessionId: string | null;
  name: string;
  force: boolean;
  tagEntries: DraftTagEntry[];
  nameError: string | null;
};

type SessionPromoteFormState = {
  mode: "promote";
  formData: SessionPromoteFormData;
  initForm: (sessionId: string) => void;
  setFormData: (patch: Partial<SessionPromoteFormData>) => void;
};

const defaultFormData: SessionPromoteFormData = {
  sessionId: null,
  name: "",
  force: false,
  tagEntries: [],
  nameError: null,
};

export const useSessionPromoteFormStore = create<SessionPromoteFormState>()((set) => ({
  mode: "promote",
  formData: defaultFormData,
  initForm: (sessionId) => set({ formData: { ...defaultFormData, sessionId } }),
  setFormData: (patch) => set((state) => ({ formData: { ...state.formData, ...patch } })),
}));
