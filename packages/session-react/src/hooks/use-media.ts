import { useEffect, useState, useSyncExternalStore } from "react";
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

/** Calls `changed` whenever the window is turned or gets another size. */
function turned(changed: () => void) {
  const media = window.matchMedia("(orientation: landscape)");
  // Not every browser that has a screen tells of its turning.
  const screen = window.screen.orientation as ScreenOrientation | undefined;
  media.addEventListener("change", changed);
  screen?.addEventListener("change", changed);
  window.addEventListener("resize", changed);
  return () => {
    media.removeEventListener("change", changed);
    screen?.removeEventListener("change", changed);
    window.removeEventListener("resize", changed);
  };
}

/** How the screen is held, where it tells: a window is wider than tall for a keyboard too. */
const screenTurn = (): string | undefined =>
  (window.screen.orientation as ScreenOrientation | undefined)?.type;

const onSide = () =>
  screenTurn()?.startsWith("landscape") ?? window.matchMedia("(orientation: landscape)").matches;

/**
 * Whether the session is used from a phone held on its side: height is what there is
 * least of then, and the workbench is laid out along a side of the picture.
 */
export function usePhoneOnSide(): boolean {
  const phone = usePhone();
  const side = useSyncExternalStore(turned, onSide, () => false);
  return phone && side;
}

/** What of the window's sides a screen's cutout and corners take, in CSS pixels. */
interface Insets {
  readonly left: number;
  readonly right: number;
}

/**
 * The side of the window a phone held on its side has the workbench's rail at: the one
 * away from the camera's cutout, which is the one with less of an inset. An iPhone gives
 * both sides the same inset, and then it is how the screen is turned that tells where the
 * cutout is: at the left as a phone is first turned, at the right turned the other way.
 * A screen with no cutout has the rail at the right.
 */
export function useRailSide(): "left" | "right" {
  const [side, setSide] = useState<"left" | "right">("right");
  useEffect(() => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;visibility:hidden;pointer-events:none;inset:0 auto auto 0;padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)";
    document.body.append(probe);
    const look = () => {
      const style = getComputedStyle(probe);
      const insets: Insets = {
        left: Number.parseFloat(style.paddingLeft) || 0,
        right: Number.parseFloat(style.paddingRight) || 0,
      };
      if (insets.left !== insets.right) {
        setSide(insets.left > insets.right ? "right" : "left");
      } else {
        setSide(insets.left > 0 && screenTurn() === "landscape-secondary" ? "left" : "right");
      }
    };
    look();
    const stop = turned(look);
    return () => {
      stop();
      probe.remove();
    };
  }, []);
  return side;
}
