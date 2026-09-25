import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type RecentSessionsState = {
  sessionIds: string[];
  recordSession: (sessionId: string) => void;
};

const recentSessionsLimit = 8;

export const useRecentSessionsStore = create<RecentSessionsState>()(
  persist(
    (set) => ({
      sessionIds: [],
      recordSession: (sessionId) => {
        set((state) => ({
          sessionIds: [sessionId, ...state.sessionIds.filter((entry) => entry !== sessionId)].slice(
            0,
            recentSessionsLimit,
          ),
        }));
      },
    }),
    {
      name: "aperture-recent-session-ids",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ sessionIds: state.sessionIds }),
    },
  ),
);
