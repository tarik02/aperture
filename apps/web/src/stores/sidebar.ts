import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Pages keep the sidebar beside them; the workbench gives the browser the room by default. */
export type SidebarLayout = "page" | "workbench";

type SidebarState = {
  open: Record<SidebarLayout, boolean>;
  setOpen: (layout: SidebarLayout, open: boolean) => void;
};

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      open: { page: true, workbench: false },
      setOpen: (layout, open) => set((state) => ({ open: { ...state.open, [layout]: open } })),
    }),
    {
      name: "aperture-sidebar",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ open: state.open }),
    },
  ),
);
