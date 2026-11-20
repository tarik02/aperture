import { useStored } from "./use-stored.ts";

const POINTERS_KEY = "aperture.session.pointers";

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/**
 * Whether the other members' pointers are shown over the picture, which they are unless
 * this browser was told otherwise. What this member's own pointer shows the others is not
 * part of it.
 */
export function useShownPointers() {
  return useStored(POINTERS_KEY, true, isBoolean);
}
