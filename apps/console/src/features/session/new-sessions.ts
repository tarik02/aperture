import { useSyncExternalStore } from "react";

/** How far making a session has come. */
export type NewSession =
  | { readonly state: "asked" }
  | { readonly state: "made"; readonly id: string }
  | { readonly state: "failed"; readonly error: unknown };

const PREFIX = "new-";

const listeners = new Set<() => void>();
let asked: ReadonlyMap<string, NewSession> = new Map();
let count = 0;

const set = (key: string, one: NewSession) => {
  asked = new Map(asked).set(key, one);
  for (const listener of listeners) {
    listener();
  }
};

/** Whether what stands where a session's id does is one that is still being made. */
export const isNewSession = (key: string) => key.startsWith(PREFIX);

/**
 * Notes a session that is asked for, under a key that stands in for its id until it has
 * one: the workbench is opened at the key at once, and waits there.
 */
export const noteAsked = (making: Promise<{ readonly id: string }>) => {
  count += 1;
  const key = `${PREFIX}${Date.now().toString(36)}-${count}`;
  set(key, { state: "asked" });
  making.then(
    (session) => set(key, { state: "made", id: session.id }),
    (error: unknown) => set(key, { state: "failed", error }),
  );
  return key;
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A session that is being made, by its key; none for a key of another page's. */
export const useNewSession = (key: string) => useSyncExternalStore(subscribe, () => asked.get(key));
