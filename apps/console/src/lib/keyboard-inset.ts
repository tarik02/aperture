import { useEffect } from "react";

/**
 * Tells the styles how much of the window's foot the on-screen keyboard covers, as
 * `--keyboard-inset`, where the browser lays the page out behind the keyboard and does not
 * make the window shorter for it: a sheet at the foot stands above the keyboard then.
 */
export function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) {
      return undefined;
    }
    const root = document.documentElement;
    const tell = () => {
      // A page that is zoomed into shows less of itself with no keyboard there.
      const covered =
        Math.abs(viewport.scale - 1) < 0.01
          ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
          : 0;
      root.style.setProperty("--keyboard-inset", `${Math.round(covered)}px`);
    };
    tell();
    viewport.addEventListener("resize", tell);
    viewport.addEventListener("scroll", tell);
    return () => {
      viewport.removeEventListener("resize", tell);
      viewport.removeEventListener("scroll", tell);
      root.style.removeProperty("--keyboard-inset");
    };
  }, []);
}
