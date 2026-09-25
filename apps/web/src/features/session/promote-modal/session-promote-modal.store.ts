import { create } from "zustand";

type SessionPromoteModalState = {
  open: boolean;
  pending: boolean;
  openModal: () => void;
  closeModal: () => void;
  setOpen: (open: boolean) => void;
  setPending: (pending: boolean) => void;
};

export const useSessionPromoteModalStore = create<SessionPromoteModalState>()((set) => ({
  open: false,
  pending: false,
  openModal: () => set({ open: true }),
  closeModal: () => set((state) => (state.pending ? state : { open: false })),
  setOpen: (open) => set((state) => (state.pending && !open ? state : { open })),
  setPending: (pending) => set({ pending }),
}));
