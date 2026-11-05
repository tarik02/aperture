import type { ShellLayout } from "#/lib/shell-layout.ts";

const themeColorSelector = 'meta[name="theme-color"]';

export function readThemeColorMeta() {
  return document.querySelector<HTMLMetaElement>(themeColorSelector)?.content ?? null;
}

export function writeThemeColorMeta(value: string | null) {
  const meta = document.querySelector<HTMLMetaElement>(themeColorSelector);
  if (!meta) {
    return;
  }
  if (value === null) {
    if (meta.hasAttribute("content")) {
      meta.removeAttribute("content");
    }
  } else if (meta.content !== value) {
    meta.content = value;
  }
}

/**
 * The browser paints the caption strip with this color. Chromium parses `theme-color` with the
 * same CSS color parser as stylesheets, so the token can be passed through unchanged.
 */
export function windowChromeThemeColor(layout: ShellLayout) {
  const token = layout === "bare" ? "--background" : "--sidebar";
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || null;
}
