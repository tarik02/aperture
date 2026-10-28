import { create } from "zustand";
import type { DeletedFilterValue } from "#/lib/api/query-keys.ts";
import type { Tenant } from "@aperture-browser/api-client";

export type TenantConfirmAction =
  | { kind: "batch-delete" }
  | { kind: "batch-restore" }
  | { kind: "delete"; tenant: Tenant };

type TenantListPageState = {
  search: string;
  setSearch: (search: string) => void;
  deleted: DeletedFilterValue;
  confirmAction: TenantConfirmAction | null;
  setDeleted: (deleted: DeletedFilterValue) => void;
  setConfirmAction: (action: TenantConfirmAction | null) => void;
};

export const useTenantListPageStore = create<TenantListPageState>()((set) => ({
  search: "",
  setSearch: (search) => set({ search }),
  deleted: "active",
  confirmAction: null,
  setDeleted: (deleted) => set({ deleted }),
  setConfirmAction: (confirmAction) => set({ confirmAction }),
}));
