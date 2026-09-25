import * as Schema from "effect/Schema";
import { create } from "zustand";
import type { SessionDetailSection } from "#/components/sessions/session-detail-modals.tsx";
import { SessionStatus, type CreateSessionResponse, type Session } from "@aperture-browser/api-client";
import type { TagFilterValue } from "#/lib/tag-filter.ts";

export type SessionConfirmAction =
  | { kind: "batch-delete" }
  | { kind: "batch-suspend" }
  | { kind: "delete"; session: Session }
  | { kind: "suspend"; session: Session }
  | { kind: "rotate"; session: Session };

interface SessionListPageState {
  status: SessionStatus | undefined;
  tags: TagFilterValue | undefined;
  detailSession: Session | null;
  detailSection: SessionDetailSection | null;
  selectedSessions: Record<string, Session>;
  confirmAction: SessionConfirmAction | null;
  setStatus: (status: string | undefined) => void;
  setTags: (tags: TagFilterValue | undefined) => void;
  openDetail: (session: Session, section?: SessionDetailSection) => void;
  setDetailSession: (session: Session) => void;
  setDetailSection: (section: SessionDetailSection | null) => void;
  openCreatedSession: (result: CreateSessionResponse) => void;
  openConnection: (session: Session) => void;
  toggleSessionSelection: (session: Session, selected: boolean) => void;
  clearSelectedSessions: () => void;
  removeSelectedSession: (sessionId: string) => void;
  setConfirmAction: (action: SessionConfirmAction | null) => void;
}

const isSessionStatus = Schema.is(SessionStatus);

export const useSessionListPageStore = create<SessionListPageState>()((set) => ({
  status: undefined,
  tags: undefined,
  detailSession: null,
  detailSection: null,
  selectedSessions: {},
  confirmAction: null,
  setStatus: (status) => set({ status: isSessionStatus(status) ? status : undefined }),
  setTags: (tags) => set({ tags }),
  openDetail: (session, section = "details") =>
    set({ detailSession: session, detailSection: section }),
  setDetailSession: (session) => set({ detailSession: session }),
  setDetailSection: (section) => set({ detailSection: section }),
  openCreatedSession: (result) =>
    set({
      detailSession: result.session,
      detailSection: "connection",
    }),
  openConnection: (session) => set({ detailSession: session, detailSection: "connection" }),
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
