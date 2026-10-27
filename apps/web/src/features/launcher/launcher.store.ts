import { create } from "zustand";

export type SessionStatusFilter = "active" | "failed" | "deleted";

interface LauncherState {
  /** Each view keeps its own search, so switching views keeps both. */
  readonly sessionSearch: string;
  readonly snapshotSearch: string;
  readonly sessionStatus: SessionStatusFilter;
  readonly showDeletedSnapshots: boolean;
  readonly setSessionSearch: (search: string) => void;
  readonly setSnapshotSearch: (search: string) => void;
  readonly setSessionStatus: (status: SessionStatusFilter) => void;
  readonly setShowDeletedSnapshots: (show: boolean) => void;
}

export const useLauncherStore = create<LauncherState>()((set) => ({
  sessionSearch: "",
  snapshotSearch: "",
  sessionStatus: "active",
  showDeletedSnapshots: false,
  setSessionSearch: (sessionSearch) => set({ sessionSearch }),
  setSnapshotSearch: (snapshotSearch) => set({ snapshotSearch }),
  setSessionStatus: (sessionStatus) => set({ sessionStatus }),
  setShowDeletedSnapshots: (showDeletedSnapshots) => set({ showDeletedSnapshots }),
}));
