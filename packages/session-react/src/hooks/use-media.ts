import { useSyncExternalStore } from "react";

/** Whether a media query holds, as the window and what points at it change. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Whether a finger is what points: what is pressed is larger then, and takes more room. */
export const useFinger = () => useMedia("(pointer: coarse)");

/**
 * Whether the window is as short as a phone held on its side: the workbench then keeps one
 * row above the picture in place of two.
 */
export const useShortWindow = () => useMedia("(pointer: coarse) and (max-height: 30rem)");
