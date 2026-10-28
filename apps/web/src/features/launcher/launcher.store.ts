import { create } from "zustand";
import type { TagFilterValue } from "#/lib/tag-filter.ts";

export type SessionStatusFilter = "active" | "failed" | "deleted";

interface LauncherState {
  /** Each view keeps its own search and filters, so switching views keeps both. */
  readonly sessionSearch: string;
  readonly snapshotSearch: string;
  readonly sessionStatus: SessionStatusFilter;
  readonly sessionTags: TagFilterValue | undefined;
  readonly snapshotTags: TagFilterValue | undefined;
  readonly showDeletedSnapshots: boolean;
  readonly setSessionSearch: (search: string) => void;
  readonly setSnapshotSearch: (search: string) => void;
  readonly setSessionStatus: (status: SessionStatusFilter) => void;
  readonly setSessionTags: (tags: TagFilterValue | undefined) => void;
  readonly setSnapshotTags: (tags: TagFilterValue | undefined) => void;
  readonly setShowDeletedSnapshots: (show: boolean) => void;
}

export const useLauncherStore = create<LauncherState>()((set) => ({
  sessionSearch: "",
  snapshotSearch: "",
  sessionStatus: "active",
  sessionTags: undefined,
  snapshotTags: undefined,
  showDeletedSnapshots: false,
  setSessionSearch: (sessionSearch) => set({ sessionSearch }),
  setSnapshotSearch: (snapshotSearch) => set({ snapshotSearch }),
  setSessionStatus: (sessionStatus) => set({ sessionStatus }),
  setSessionTags: (sessionTags) => set({ sessionTags }),
  setSnapshotTags: (snapshotTags) => set({ snapshotTags }),
  setShowDeletedSnapshots: (showDeletedSnapshots) => set({ showDeletedSnapshots }),
}));
