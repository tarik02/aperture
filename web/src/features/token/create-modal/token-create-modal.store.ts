import { create } from "zustand";

type TokenCreateModalState = {
  open: boolean;
  openModal: () => void;
  closeModal: () => void;
  setOpen: (open: boolean) => void;
};

export const useTokenCreateModalStore = create<TokenCreateModalState>()((set) => ({
  open: false,
  openModal: () => set({ open: true }),
  closeModal: () => set({ open: false }),
  setOpen: (open) => set({ open }),
}));
