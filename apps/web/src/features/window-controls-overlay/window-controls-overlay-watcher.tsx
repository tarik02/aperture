import { useTheme } from "next-themes";
import { useEffect } from "react";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { useFork } from "@aperture-browser/session-react";
import type { ShellLayout } from "#/lib/shell-layout.ts";
import {
  WindowControlsOverlay,
  WindowControlsOverlayLive,
} from "#/features/window-controls-overlay/window-controls-overlay-service.ts";
import { WINDOW_CONTROLS_OVERLAY_CLASSES } from "#/features/window-controls-overlay/window-controls-overlay.ts";

function applyClasses(classes: readonly string[]) {
  const root = document.documentElement;
  root.classList.remove(...WINDOW_CONTROLS_OVERLAY_CLASSES);
  if (classes.length > 0) {
    root.classList.add(...classes);
  }
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
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta && meta.content !== value) {
    meta.content = value;
  }
}

/**
 * Applies the overlay classes from the WCO service, and keeps the browser's caption color on the
 * app chrome.
 */
export function WindowControlsOverlayWatcher({ layout }: { layout: ShellLayout }) {
  const { resolvedTheme } = useTheme();

  useFork(
    () =>
      Effect.gen(function* () {
        const overlay = yield* WindowControlsOverlay;
        yield* Stream.runForEach(overlay.changes, (classes) =>
          Effect.sync(() => applyClasses(classes)),
        );
      }).pipe(Effect.provide(WindowControlsOverlayLive)),
    [],
  );

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

  return null;
}
