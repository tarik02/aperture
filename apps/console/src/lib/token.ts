import { useSyncExternalStore } from "react";

const KEY = "aperture.console.token";

const listeners = new Set<() => void>();
/** Who hears that another tab signed in or out with a token. */
const elsewhere = new Set<() => void>();

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
  const before = current;
  current = read();
  for (const listener of listeners) {
    listener();
  }
  if (current !== before) {
    for (const listener of elsewhere) {
      listener();
    }
  }
});

/** Hears that the token changed in another tab: who is signed in here is another then. */
export const onTokenChangedElsewhere = (listener: () => void) => {
  elsewhere.add(listener);
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useToken = () => useSyncExternalStore(subscribe, token);
