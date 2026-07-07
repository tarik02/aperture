import { create } from "zustand";

type TokenAuthModalState = {
  open: boolean;
  openModal: () => void;
  closeModal: () => void;
  setOpen: (open: boolean) => void;
};

export const useTokenAuthModalStore = create<TokenAuthModalState>()((set) => ({
  open: false,
  openModal: () => set({ open: true }),
  closeModal: () => set({ open: false }),
  setOpen: (open) => set({ open }),
}));
