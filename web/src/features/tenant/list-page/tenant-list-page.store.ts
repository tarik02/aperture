import { create } from "zustand";
import type { DeletedFilterValue } from "#/lib/api/query-keys.ts";
import type { Tenant } from "#/lib/api/schemas.ts";

export type TenantConfirmAction =
  | { kind: "batch-delete" }
  | { kind: "batch-restore" }
  | { kind: "delete"; tenant: Tenant };

type TenantListPageState = {
  deleted: DeletedFilterValue;
  selectedTenants: Record<string, Tenant>;
  confirmAction: TenantConfirmAction | null;
  setDeleted: (deleted: DeletedFilterValue) => void;
  toggleTenantSelection: (tenant: Tenant, selected: boolean) => void;
  clearSelectedTenants: () => void;
  removeSelectedTenant: (tenantId: string) => void;
  setConfirmAction: (action: TenantConfirmAction | null) => void;
};

export const useTenantListPageStore = create<TenantListPageState>()((set) => ({
  deleted: "active",
  selectedTenants: {},
  confirmAction: null,
  setDeleted: (deleted) => set({ deleted }),
  toggleTenantSelection: (tenant, selected) =>
    set((state) => {
      const selectedTenants = { ...state.selectedTenants };
      if (selected) {
        selectedTenants[tenant.id] = tenant;
      } else {
        delete selectedTenants[tenant.id];
      }
      return { selectedTenants };
    }),
  clearSelectedTenants: () => set({ selectedTenants: {} }),
  removeSelectedTenant: (tenantId) =>
    set((state) => {
      const selectedTenants = { ...state.selectedTenants };
      delete selectedTenants[tenantId];
      return { selectedTenants };
    }),
  setConfirmAction: (confirmAction) => set({ confirmAction }),
}));
