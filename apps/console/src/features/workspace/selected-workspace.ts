import { useSyncExternalStore } from "react";

/** A setting this browser keeps for the console, and tells whoever shows it of each change. */
const kept = (key: string) => {
  const listeners = new Set<() => void>();
  const read = () => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  let value = read();
  return {
    get: () => value,
    set: (next: string | null) => {
      value = next;
      try {
        if (next === null) {
          localStorage.removeItem(key);
        } else {
          localStorage.setItem(key, next);
        }
      } catch {
        // Kept for this page only.
      }
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

const workspace = kept("aperture.console.workspace");
const everyWorkspace = kept("aperture.console.workspaces.all");

/** The workspace whose sessions and snapshots are shown; none for the account's own. */
export const selectedWorkspace = workspace.get;

export const selectWorkspace = workspace.set;

export const useSelectedWorkspaceId = () =>
  useSyncExternalStore(workspace.subscribe, workspace.get);

/** Whether an admin is shown the workspaces they are not in as well as their own. */
export const useShowsEveryWorkspace = () =>
  useSyncExternalStore(everyWorkspace.subscribe, everyWorkspace.get) === "true";

export const showEveryWorkspace = (shown: boolean) => everyWorkspace.set(shown ? "true" : null);
