import { useSyncExternalStore } from "react";

/** Below the width at which a table is a table: where its rows are blocks of their own. */
const PHONE = "(max-width: 639.98px)";

/** Whether the window is as narrow as a phone's, as it changes. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const media = window.matchMedia(PHONE);
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    () => window.matchMedia(PHONE).matches,
  );
}
