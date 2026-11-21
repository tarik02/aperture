import { useSyncExternalStore } from "react";

const KEY = "aperture.console.workspace";

const listeners = new Set<() => void>();

const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

let selected = read();

/** The workspace whose sessions and snapshots are shown; none for the account's own. */
export const selectedWorkspace = () => selected;

export const selectWorkspace = (id: string | null) => {
  selected = id;
  try {
    if (id === null) {
      localStorage.removeItem(KEY);
    } else {
      localStorage.setItem(KEY, id);
    }
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

export const useSelectedWorkspaceId = () => useSyncExternalStore(subscribe, selectedWorkspace);
