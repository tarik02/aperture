import { create } from "zustand";

type TenantFormModalState = {
  open: boolean;
  openModal: () => void;
  closeModal: () => void;
  setOpen: (open: boolean) => void;
};

export const useTenantFormModalStore = create<TenantFormModalState>()((set) => ({
  open: false,
  openModal: () => set({ open: true }),
  closeModal: () => set({ open: false }),
  setOpen: (open) => set({ open }),
}));
