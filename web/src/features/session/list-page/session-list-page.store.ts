import { create } from "zustand";
import type { TransientCdpCredentials } from "#/components/sessions/connection-panel.tsx";
import type { SessionDetailSection } from "#/components/sessions/session-detail-modals.tsx";
import type { CreateSessionResponse, Session } from "#/lib/api/schemas.ts";
import type { TagFilterValue } from "#/lib/tag-filter.ts";

export type SessionConfirmAction =
  | { kind: "batch-delete" }
  | { kind: "batch-suspend" }
  | { kind: "delete"; session: Session }
  | { kind: "suspend"; session: Session }
  | { kind: "rotate"; session: Session };

type SessionListPageState = {
  status: string | undefined;
  tags: TagFilterValue | undefined;
  detailSession: Session | null;
  detailSection: SessionDetailSection | null;
  transientCdp: TransientCdpCredentials;
  selectedSessions: Record<string, Session>;
  confirmAction: SessionConfirmAction | null;
  setStatus: (status: string | undefined) => void;
  setTags: (tags: TagFilterValue | undefined) => void;
  openDetail: (session: Session, section?: SessionDetailSection) => void;
  setDetailSection: (section: SessionDetailSection | null) => void;
  setTransientCdp: (credentials: TransientCdpCredentials) => void;
  openCreatedSession: (result: CreateSessionResponse) => void;
  openConnection: (session: Session, credentials: Exclude<TransientCdpCredentials, null>) => void;
  toggleSessionSelection: (session: Session, selected: boolean) => void;
  clearSelectedSessions: () => void;
  removeSelectedSession: (sessionId: string) => void;
  setConfirmAction: (action: SessionConfirmAction | null) => void;
};

export const useSessionListPageStore = create<SessionListPageState>()((set) => ({
  status: undefined,
  tags: undefined,
  detailSession: null,
  detailSection: null,
  transientCdp: null,
  selectedSessions: {},
  confirmAction: null,
  setStatus: (status) => set({ status }),
  setTags: (tags) => set({ tags }),
  openDetail: (session, section = "details") =>
    set({ transientCdp: null, detailSession: session, detailSection: section }),
  setDetailSection: (section) =>
    set((state) => ({
      detailSection: section,
      transientCdp: section ? state.transientCdp : null,
    })),
  setTransientCdp: (credentials) => set({ transientCdp: credentials }),
  openCreatedSession: (result) =>
    set({
      transientCdp: { cdpUrl: result.cdpUrl, cdpToken: result.cdpToken },
      detailSession: result.session,
      detailSection: "connection",
    }),
  openConnection: (session, credentials) =>
    set({ transientCdp: credentials, detailSession: session, detailSection: "connection" }),
  toggleSessionSelection: (session, selected) =>
    set((state) => {
      const selectedSessions = { ...state.selectedSessions };
      if (selected) {
        selectedSessions[session.id] = session;
      } else {
        delete selectedSessions[session.id];
      }
      return { selectedSessions };
    }),
  clearSelectedSessions: () => set({ selectedSessions: {} }),
  removeSelectedSession: (sessionId) =>
    set((state) => {
      const selectedSessions = { ...state.selectedSessions };
      delete selectedSessions[sessionId];
      return { selectedSessions };
    }),
  setConfirmAction: (confirmAction) => set({ confirmAction }),
}));
