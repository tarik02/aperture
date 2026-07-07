import { create } from "zustand";

export type DraftTagEntry = {
  key: string;
  value: string;
};

type SessionFormData = {
  label: string;
  channel: string;
  baseSnapshot: string | null;
  browserArgs: string[];
  tagEntries: DraftTagEntry[];
  channelError: string | null;
};

type SessionFormState = {
  mode: "create";
  formData: SessionFormData;
  initForm: () => void;
  setFormData: (patch: Partial<SessionFormData>) => void;
};

const defaultFormData: SessionFormData = {
  label: "",
  channel: "",
  baseSnapshot: null,
  browserArgs: [],
  tagEntries: [],
  channelError: null,
};

export const useSessionFormStore = create<SessionFormState>()((set) => ({
  mode: "create",
  formData: defaultFormData,
  initForm: () => set({ formData: defaultFormData }),
  setFormData: (patch) => set((state) => ({ formData: { ...state.formData, ...patch } })),
}));
