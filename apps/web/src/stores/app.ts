import { create } from "zustand";

type AppStore = {
  ready: boolean;
};

export const useAppStore = create<AppStore>(() => ({
  ready: true,
}));
