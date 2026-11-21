import { useCallback, useSyncExternalStore } from "react";

/** What each key holds now, as it was read or last set, for all who use the key. */
const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function read(key: string): unknown {
  if (!values.has(key)) {
    let stored: unknown;
    try {
      const text = window.localStorage.getItem(key);
      stored = text === null ? undefined : JSON.parse(text);
    } catch {
      // Storage that is unavailable gives the default.
      stored = undefined;
    }
    values.set(key, stored);
  }
  return values.get(key);
}

/**
 * A choice this browser remembers, the same for everything on the page that uses the key.
 * It lasts for the page where storage is unavailable.
 */
export function useStored<Value>(
  key: string,
  fallback: Value,
  valid: (value: unknown) => value is Value,
): readonly [Value, (value: Value) => void] {
  const subscribe = useCallback(
    (listener: () => void) => {
      const heard = listeners.get(key) ?? new Set();
      listeners.set(key, heard);
      heard.add(listener);
      return () => {
        heard.delete(listener);
      };
    },
    [key],
  );
  const stored = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => undefined,
  );
  // What another version wrote gives the default.
  const value = valid(stored) ? stored : fallback;

  const store = useCallback(
    (next: Value) => {
      values.set(key, next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Kept for this page only.
      }
      for (const listener of listeners.get(key) ?? []) {
        listener();
      }
    },
    [key],
  );

  return [value, store];
}
