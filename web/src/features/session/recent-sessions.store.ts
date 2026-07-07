import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Session } from "#/lib/api/schemas.ts";

export type RecentSession = {
  id: string;
  label: string | null;
  baseSnapshotName: string | null;
  browserChannel: string | null;
  openedAt: number;
};

type RecentSessionsState = {
  sessions: RecentSession[];
  recordSession: (session: Session) => void;
};

const recentSessionsLimit = 8;

export const useRecentSessionsStore = create<RecentSessionsState>()(
  persist(
    (set) => ({
      sessions: [],
      recordSession: (session) => {
        const recentSession: RecentSession = {
          id: session.id,
          label: session.label ?? null,
          baseSnapshotName: session.baseSnapshotName ?? null,
          browserChannel: session.browserChannel ?? null,
          openedAt: Date.now(),
        };

        set((state) => ({
          sessions: [
            recentSession,
            ...state.sessions.filter((entry) => entry.id !== session.id),
          ].slice(0, recentSessionsLimit),
        }));
      },
    }),
    {
      name: "aperture-recent-sessions",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ sessions: state.sessions }),
    },
  ),
);
