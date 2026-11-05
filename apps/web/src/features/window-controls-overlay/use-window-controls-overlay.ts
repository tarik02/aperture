import { useTheme } from "next-themes";
import { useEffect, useLayoutEffect, useState } from "react";
import type { ShellLayout } from "#/lib/shell-layout.ts";
import {
  getWindowControlsOverlay,
  WINDOW_CONTROLS_OVERLAY_CLASSES,
  windowControlsOverlayClasses,
} from "#/features/window-controls-overlay/window-controls-overlay.ts";

const themeColorSelector = 'meta[name="theme-color"]';

function readOverlayClasses() {
  if (typeof window === "undefined") {
    return [];
  }
  return windowControlsOverlayClasses(getWindowControlsOverlay(), window.innerWidth);
}

/**
 * The browser paints the caption strip with the theme color. Chromium parses it with the same CSS
 * color parser as stylesheets, so the design token can be used unchanged.
 */
function windowChromeThemeColor(layout: ShellLayout) {
  const token = layout === "bare" ? "--background" : "--sidebar";
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

function setThemeColor(value: string) {
  const meta = document.querySelector<HTMLMetaElement>(themeColorSelector);
  if (meta && meta.content !== value) {
    meta.content = value;
  }
}

/**
 * Keeps the window-controls overlay classes and the browser's caption color in step with the
 * states that own them: the overlay geometry, the theme and the app shell layout.
 */
export function useWindowControlsOverlay(layout: ShellLayout) {
  const [classes, setClasses] = useState<readonly string[]>(readOverlayClasses);
  const { resolvedTheme } = useTheme();

  useLayoutEffect(() => {
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
    // The theme provider applies the theme class in its own effect, so read the token next frame.
    const frame = requestAnimationFrame(() => {
      const color = windowChromeThemeColor(layout);
      if (color) {
        setThemeColor(color);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, resolvedTheme]);
}
