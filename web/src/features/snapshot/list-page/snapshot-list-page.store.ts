import { create } from "zustand";
import type { SnapshotDetailSection } from "#/components/snapshots/snapshot-detail-modals.tsx";
import type { DeletedFilterValue } from "#/lib/api/query-keys.ts";
import type { Snapshot } from "#/lib/api/schemas.ts";
import type { TagFilterValue } from "#/lib/tag-filter.ts";

export type SnapshotConfirmAction =
  | { kind: "batch-delete" }
  | { kind: "delete"; snapshot: Snapshot };

type SnapshotListPageState = {
  deleted: DeletedFilterValue;
  tags: TagFilterValue | undefined;
  detailSnapshot: Snapshot | null;
  detailSection: SnapshotDetailSection | null;
  selectedSnapshots: Record<string, Snapshot>;
  confirmAction: SnapshotConfirmAction | null;
  setDeleted: (deleted: DeletedFilterValue) => void;
  setTags: (tags: TagFilterValue | undefined) => void;
  showSnapshot: (snapshot: Snapshot, section?: SnapshotDetailSection) => void;
  setDetailSection: (section: SnapshotDetailSection | null) => void;
  toggleSnapshotSelection: (snapshot: Snapshot, selected: boolean) => void;
  clearSelectedSnapshots: () => void;
  removeSelectedSnapshot: (snapshotId: string) => void;
  setConfirmAction: (action: SnapshotConfirmAction | null) => void;
};

export const useSnapshotListPageStore = create<SnapshotListPageState>()((set) => ({
  deleted: "active",
  tags: undefined,
  detailSnapshot: null,
  detailSection: null,
  selectedSnapshots: {},
  confirmAction: null,
  setDeleted: (deleted) => set({ deleted }),
  setTags: (tags) => set({ tags }),
  showSnapshot: (snapshot, section = "details") =>
    set({ detailSnapshot: snapshot, detailSection: section }),
  setDetailSection: (detailSection) => set({ detailSection }),
  toggleSnapshotSelection: (snapshot, selected) =>
    set((state) => {
      const selectedSnapshots = { ...state.selectedSnapshots };
      if (selected) {
        selectedSnapshots[snapshot.id] = snapshot;
      } else {
        delete selectedSnapshots[snapshot.id];
      }
      return { selectedSnapshots };
    }),
  clearSelectedSnapshots: () => set({ selectedSnapshots: {} }),
  removeSelectedSnapshot: (snapshotId) =>
    set((state) => {
      const selectedSnapshots = { ...state.selectedSnapshots };
      delete selectedSnapshots[snapshotId];
      return { selectedSnapshots };
    }),
  setConfirmAction: (confirmAction) => set({ confirmAction }),
}));
