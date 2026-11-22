import { useEffect } from "react";

/**
 * Tells the styles what of the window the on-screen keyboard leaves to be seen, where the
 * browser lays the page out behind the keyboard and does not make the window shorter for
 * it: how much of the window's foot is covered, as `--keyboard-inset`, and how far down the
 * window what is seen begins, as `--keyboard-top`, which is more than nothing where the
 * browser moved the window up to show what is typed into. A sheet at the foot stands above
 * the keyboard then, and is no taller than what is left.
 */
export function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) {
      return undefined;
    }
    const root = document.documentElement;
    let revealing = 0;
    const tell = () => {
      // A page that is zoomed into shows less of itself with no keyboard there.
      const whole = Math.abs(viewport.scale - 1) < 0.01;
      const top = whole ? Math.max(0, viewport.offsetTop) : 0;
      const covered = whole ? Math.max(0, window.innerHeight - viewport.height - top) : 0;
      root.style.setProperty("--keyboard-inset", `${Math.round(covered)}px`);
      root.style.setProperty("--keyboard-top", `${Math.round(top)}px`);
      // What is typed into in a dialog may be under where the dialog now ends: it is brought
      // back into what the dialog shows, once the dialog is as tall as it is to be.
      cancelAnimationFrame(revealing);
      revealing = requestAnimationFrame(() => {
        const typed = document.activeElement;
        if (
          typed instanceof HTMLElement &&
          typed.matches("input, textarea") &&
          typed.closest('[data-slot="dialog-content"]') !== null
        ) {
          typed.scrollIntoView({ block: "nearest" });
        }
      });
    };
    tell();
    viewport.addEventListener("resize", tell);
    viewport.addEventListener("scroll", tell);
    return () => {
      cancelAnimationFrame(revealing);
      viewport.removeEventListener("resize", tell);
      viewport.removeEventListener("scroll", tell);
      root.style.removeProperty("--keyboard-inset");
      root.style.removeProperty("--keyboard-top");
    };
  }, []);
}
