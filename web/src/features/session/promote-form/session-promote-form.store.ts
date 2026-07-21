import { create } from "zustand";
import type { DraftTagEntry } from "#/features/session/form/session-form.store.ts";

type SessionPromoteFormData = {
  sessionId: string | null;
  name: string;
  description: string;
  replaceExisting: boolean;
  suspendBeforePromote: boolean;
  tagEntries: DraftTagEntry[];
  nameError: string | null;
};

type SessionPromoteFormState = {
  mode: "promote";
  formData: SessionPromoteFormData;
  initForm: (sessionId: string, suspendBeforePromote: boolean) => void;
  setFormData: (patch: Partial<SessionPromoteFormData>) => void;
};

const defaultFormData: SessionPromoteFormData = {
  sessionId: null,
  name: "",
  description: "",
  replaceExisting: false,
  suspendBeforePromote: false,
  tagEntries: [],
  nameError: null,
};

export const useSessionPromoteFormStore = create<SessionPromoteFormState>()((set) => ({
  mode: "promote",
  formData: defaultFormData,
  initForm: (sessionId, suspendBeforePromote) =>
    set({ formData: { ...defaultFormData, sessionId, suspendBeforePromote } }),
  setFormData: (patch) => set((state) => ({ formData: { ...state.formData, ...patch } })),
}));
