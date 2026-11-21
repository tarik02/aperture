import { useTheme } from "next-themes";
import { useEffect } from "react";

type WindowControlsOverlay = EventTarget & {
  readonly visible: boolean;
  getTitlebarAreaRect: () => DOMRectReadOnly;
};

declare global {
  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay;
  }
}

const CLASSES = ["wco", "wco-left", "wco-right"] as const;

/** Which sides of the window its buttons take, as classes the styles lay the title bars out by. */
function overlayClasses(overlay: WindowControlsOverlay | undefined): ReadonlyArray<string> {
  if (overlay?.visible !== true) {
    return [];
  }
  const rect = overlay.getTitlebarAreaRect();
  const classes: string[] = ["wco"];
  if (rect.x > 1) {
    classes.push("wco-left");
  }
  if (rect.x + rect.width < window.innerWidth - 1) {
    classes.push("wco-right");
  }
  return classes;
}

/**
 * In an installed window whose title bar is given to the page, says so on the root element,
 * and keeps the colour the browser paints behind the window's buttons the title bars' own.
 */
export function useWindowControlsOverlay() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const overlay = navigator.windowControlsOverlay;
    if (overlay === undefined) {
      return undefined;
    }
    const root = document.documentElement;
    const update = () => {
      const classes = overlayClasses(overlay);
      for (const name of CLASSES) {
        root.classList.toggle(name, classes.includes(name));
      }
    };
    update();
    overlay.addEventListener("geometrychange", update);
    window.addEventListener("resize", update);
    return () => {
      overlay.removeEventListener("geometrychange", update);
      window.removeEventListener("resize", update);
      root.classList.remove(...CLASSES);
    };
  }, []);

  useEffect(() => {
    // The theme's class is put on the root in an effect of its provider: read a frame later.
    const frame = requestAnimationFrame(() => {
      const color = getComputedStyle(document.documentElement).getPropertyValue("--sidebar").trim();
      if (color === "") {
        return;
      }
      for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
        meta.content = color;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [resolvedTheme]);
}
