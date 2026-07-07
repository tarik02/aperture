import { create } from "zustand";

type SessionCreateModalState = {
  open: boolean;
  openModal: () => void;
  closeModal: () => void;
  setOpen: (open: boolean) => void;
};

export const useSessionCreateModalStore = create<SessionCreateModalState>()((set) => ({
  open: false,
  openModal: () => set({ open: true }),
  closeModal: () => set({ open: false }),
  setOpen: (open) => set({ open }),
}));
