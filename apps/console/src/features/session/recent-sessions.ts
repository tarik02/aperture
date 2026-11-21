import { useSyncExternalStore } from "react";

const KEY = "aperture.console.recent-sessions";
const KEPT = 5;

const listeners = new Set<() => void>();

const read = (): ReadonlyArray<string> => {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(kept) ? kept.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
};

let recent = read();

/** Notes that a session was opened in this browser: the last few are kept at hand. */
export const noteOpened = (id: string) => {
  if (recent[0] === id) {
    return;
  }
  recent = [id, ...recent.filter((one) => one !== id)].slice(0, KEPT);
  try {
    localStorage.setItem(KEY, JSON.stringify(recent));
  } catch {
    // Kept for this page only.
  }
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useRecentSessions = () => useSyncExternalStore(subscribe, () => recent);
