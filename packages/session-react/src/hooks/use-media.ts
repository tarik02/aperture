import { useSyncExternalStore } from "react";
import { useSessionSnapshot } from "../session.tsx";

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

/**
 * Whether the session is used from a phone, as the session is told it is: the workbench
 * is then the picture with a bar below it, in place of a browser's rows above it.
 */
export const usePhone = () => useSessionSnapshot().phone;

/** Whether a finger is what points: what is pressed is larger then, and takes more room. */
export const useFinger = () => useMedia("(pointer: coarse)");

/**
 * Whether the window is as short as a phone held on its side: the workbench then keeps one
 * row above the picture in place of two.
 */
export const useShortWindow = () => useMedia("(pointer: coarse) and (max-height: 30rem)");
