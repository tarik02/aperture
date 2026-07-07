import { create } from "zustand";

type SessionPromoteModalState = {
  open: boolean;
  openModal: () => void;
  closeModal: () => void;
  setOpen: (open: boolean) => void;
};

export const useSessionPromoteModalStore = create<SessionPromoteModalState>()((set) => ({
  open: false,
  openModal: () => set({ open: true }),
  closeModal: () => set({ open: false }),
  setOpen: (open) => set({ open }),
}));
