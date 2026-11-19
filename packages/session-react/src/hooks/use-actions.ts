import { useCallback } from "react";
import type { Target } from "@aperture-browser/session-client";
import { useLease, useSession, useSessionSnapshot } from "../session.tsx";

export interface TabSound {
  /** The tab plays something now. */
  readonly sounds: boolean;
  /** The tab is muted for this client. */
  readonly muted: boolean;
  readonly toggle: () => void;
}

/** A tab's sound, as this client hears it. */
export function useTabSound(target: Target | undefined): TabSound {
  const session = useSession();
  const muted = useSessionSnapshot().muted.includes(target?.tab ?? -1);
  const tab = target?.tab;
  const toggle = useCallback(() => {
    if (tab !== undefined) {
      session.setMuted(tab, !muted);
    }
  }, [session, tab, muted]);
  return { sounds: target?.sounds ?? false, muted, toggle };
}

export interface InputState {
  readonly open: boolean;
  /** This member may open, close and take tabs elsewhere. */
  readonly changes: boolean;
  /** This member may give the watched tab input. */
  readonly gives: boolean;
}

/** What this member may do in the session now. */
export function useInputState(): InputState {
  const snapshot = useSessionSnapshot();
  const lease = useLease();
  const open = snapshot.connection.state === "open";
  const changes = open && lease.givesInput;
  return { open, changes, gives: changes && snapshot.selected !== undefined };
}
