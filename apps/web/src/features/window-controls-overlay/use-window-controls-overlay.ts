import { useTheme } from "next-themes";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ShellLayout } from "#/lib/shell-layout.ts";
import {
  readThemeColorMeta,
  windowChromeThemeColor,
  writeThemeColorMeta,
} from "#/features/window-controls-overlay/theme-color.ts";
import {
  getWindowControlsOverlay,
  WINDOW_CONTROLS_OVERLAY_CLASSES,
  windowControlsOverlayClasses,
} from "#/features/window-controls-overlay/window-controls-overlay.ts";

function readOverlayClasses() {
  if (typeof window === "undefined") {
    return [];
  }
  return windowControlsOverlayClasses(getWindowControlsOverlay(), window.innerWidth);
}

/**
 * Keeps the window-controls overlay classes and the browser's caption color in step with the
 * states that own them: the overlay geometry, the theme and the app shell layout.
 */
export function useWindowControlsOverlay(layout: ShellLayout) {
  const [classes, setClasses] = useState<readonly string[]>(readOverlayClasses);
  const { resolvedTheme } = useTheme();
  const defaultThemeColor = useRef<string | null>(null);

  useLayoutEffect(() => {
    defaultThemeColor.current ??= readThemeColorMeta();
    const root = document.documentElement;
    root.classList.remove(...WINDOW_CONTROLS_OVERLAY_CLASSES);
    if (classes.length > 0) {
      root.classList.add(...classes);
    }
    return () => root.classList.remove(...WINDOW_CONTROLS_OVERLAY_CLASSES);
  }, [classes]);

  useEffect(() => {
    const overlay = getWindowControlsOverlay();
    if (!overlay) {
      return;
    }
    const update = () => setClasses(readOverlayClasses());
    update();
    overlay.addEventListener("geometrychange", update);
    window.addEventListener("resize", update);
    return () => {
      overlay.removeEventListener("geometrychange", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    if (!resolvedTheme) {
      return;
    }
    // The theme class is applied in the theme provider's own effect, so read the token next frame.
    const frame = requestAnimationFrame(() => {
      writeThemeColorMeta(
        classes.length > 0
          ? (windowChromeThemeColor(layout) ?? defaultThemeColor.current)
          : defaultThemeColor.current,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [classes, layout, resolvedTheme]);

  useEffect(
    () => () => {
      writeThemeColorMeta(defaultThemeColor.current);
    },
    [],
  );
}
