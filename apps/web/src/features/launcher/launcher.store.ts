import { create } from "zustand";
import type { SessionSort } from "@aperture-browser/api-client";
import type { TagFilterValue } from "#/lib/tag-filter.ts";

export type SessionStatusFilter = "active" | "failed" | "deleted";

interface LauncherState {
  /** Each view keeps its own search and filters, so switching views keeps both. */
  readonly sessionSearch: string;
  readonly snapshotSearch: string;
  readonly sessionStatus: SessionStatusFilter;
  readonly sessionSort: SessionSort;
  readonly sessionTags: TagFilterValue | undefined;
  readonly snapshotTags: TagFilterValue | undefined;
  readonly showDeletedSnapshots: boolean;
  readonly setSessionSearch: (search: string) => void;
  readonly setSnapshotSearch: (search: string) => void;
  readonly setSessionStatus: (status: SessionStatusFilter) => void;
  readonly setSessionSort: (sort: SessionSort) => void;
  readonly setSessionTags: (tags: TagFilterValue | undefined) => void;
  readonly setSnapshotTags: (tags: TagFilterValue | undefined) => void;
  readonly setShowDeletedSnapshots: (show: boolean) => void;
}

export const useLauncherStore = create<LauncherState>()((set) => ({
  sessionSearch: "",
  snapshotSearch: "",
  sessionStatus: "active",
  sessionSort: "lastConnectedAt",
  sessionTags: undefined,
  snapshotTags: undefined,
  showDeletedSnapshots: false,
  setSessionSearch: (sessionSearch) => set({ sessionSearch }),
  setSnapshotSearch: (snapshotSearch) => set({ snapshotSearch }),
  setSessionStatus: (sessionStatus) => set({ sessionStatus }),
  setSessionSort: (sessionSort) => set({ sessionSort }),
  setSessionTags: (sessionTags) => set({ sessionTags }),
  setSnapshotTags: (snapshotTags) => set({ snapshotTags }),
  setShowDeletedSnapshots: (showDeletedSnapshots) => set({ showDeletedSnapshots }),
}));
