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
 * The theme tokens are authored as oklch, but the caption strip only needs an sRGB color.
 * Rasterizing the token and reading the pixel back keeps the strip aligned with the token
 * instead of duplicating the color as a hex literal.
 */
function resolveCssColor(value: string) {
  if (!value) {
    return null;
  }
  const context = document.createElement("canvas").getContext("2d");
  if (!context) {
    return null;
  }
  // An invalid color leaves the transparent sentinel in place, which the fill below reports.
  context.fillStyle = "rgba(0, 0, 0, 0)";
  context.fillStyle = value;
  context.clearRect(0, 0, 1, 1);
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha === 0) {
    return null;
  }
  const hex = [red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}

/**
 * The browser paints the caption strip with this color, so it has to match the surface at the top
 * of the page: the app chrome when there is one, otherwise the page background.
 */
export function windowChromeThemeColor(layout: ShellLayout) {
  const token = layout === "bare" ? "--background" : "--sidebar";
  const value = getComputedStyle(document.documentElement).getPropertyValue(token);
  return resolveCssColor(value.trim());
}
