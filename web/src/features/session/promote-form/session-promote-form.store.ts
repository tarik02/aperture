import { create } from "zustand";
import type { DraftTagEntry } from "#/features/session/form/session-form.store.ts";

type SessionPromoteFormData = {
  sessionId: string | null;
  baseSnapshotName: string | null;
  name: string;
  description: string;
  suspendBeforePromote: boolean;
  tagEntries: DraftTagEntry[];
  nameError: string | null;
};

type SessionPromoteFormInput = {
  sessionId: string;
  baseSnapshotName: string | null;
  suspendBeforePromote: boolean;
};

type SessionPromoteFormState = {
  mode: "promote";
  formData: SessionPromoteFormData;
  initForm: (input: SessionPromoteFormInput) => void;
  setFormData: (patch: Partial<SessionPromoteFormData>) => void;
};

const defaultFormData: SessionPromoteFormData = {
  sessionId: null,
  baseSnapshotName: null,
  name: "",
  description: "",
  suspendBeforePromote: false,
  tagEntries: [],
  nameError: null,
};

export const useSessionPromoteFormStore = create<SessionPromoteFormState>()((set) => ({
  mode: "promote",
  formData: defaultFormData,
  initForm: ({ sessionId, baseSnapshotName, suspendBeforePromote }) =>
    set({
      formData: {
        ...defaultFormData,
        sessionId,
        baseSnapshotName,
        name: baseSnapshotName ?? "",
        suspendBeforePromote,
      },
    }),
  setFormData: (patch) => set((state) => ({ formData: { ...state.formData, ...patch } })),
}));
