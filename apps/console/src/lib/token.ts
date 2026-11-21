import { useSyncExternalStore } from "react";

const KEY = "aperture.console.token";

const listeners = new Set<() => void>();

const read = () => {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    // Storage that is unavailable keeps nobody signed in.
    return undefined;
  }
};

let current = read();

/** The API token whoever uses this browser signed in with; none when nobody did. */
export const token = () => current;

export const keepToken = (next: string | undefined) => {
  current = next;
  try {
    if (next === undefined) {
      localStorage.removeItem(KEY);
    } else {
      localStorage.setItem(KEY, next);
    }
  } catch {
    // Kept for this page only.
  }
  for (const listener of listeners) {
    listener();
  }
};

// Another tab of this browser signs in and out for this one too.
addEventListener("storage", (event) => {
  if (event.key !== KEY && event.key !== null) {
    return;
  }
  current = read();
  for (const listener of listeners) {
    listener();
  }
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useToken = () => useSyncExternalStore(subscribe, token);
