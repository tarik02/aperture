import type { FileTreeIconConfig } from "@pierre/trees";
import type { CSSProperties } from "react";

/** Row height in pixels, shared by the tree and the drop highlight drawn over it. */
export const treeItemHeight = 30;

/*
 * Icons the built-in set lacks: recordings and other media. Symbols follow the built-in
 * ones: a 16×16 view box, a translucent `bg` layer and an opaque `fg` layer.
 */
const mediaSpriteSheet = `<svg data-icon-sprite aria-hidden="true" width="0" height="0">
  <symbol id="aperture-file-video" viewBox="0 0 16 16">
    <rect x="1" y="3" width="14" height="10" rx="2.5" fill="currentColor" class="bg" opacity=".5"/>
    <path fill="currentColor" class="fg" d="M6.5 5.9v4.2a.5.5 0 0 0 .76.43l3.4-2.1a.5.5 0 0 0 0-.86l-3.4-2.1a.5.5 0 0 0-.76.43"/>
  </symbol>
  <symbol id="aperture-file-audio" viewBox="0 0 16 16">
    <path fill="currentColor" class="bg" opacity=".5" d="M6 4.5 13 3v2L6 6.5z"/>
    <path fill="currentColor" class="fg" d="M13.5 2.1a.75.75 0 0 0-.66-.13l-7 1.5A.75.75 0 0 0 5.25 4.2v6.4A2.25 2.25 0 1 0 6.75 12.7V7.1l5.5-1.18v3.2a2.25 2.25 0 1 0 1.5 2.1V2.7a.75.75 0 0 0-.25-.6"/>
  </symbol>
</svg>`;

const videoExtensions = ["mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv"];
const audioExtensions = ["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"];

export const treeIcons: FileTreeIconConfig = {
  set: "complete",
  colored: true,
  spriteSheet: mediaSpriteSheet,
  byFileExtension: Object.fromEntries([
    ...videoExtensions.map((extension) => [extension, "aperture-file-video"]),
    ...audioExtensions.map((extension) => [extension, "aperture-file-audio"]),
  ]),
};

/**
 * Maps the app's design tokens onto the tree's override variables. The tokens are plain
 * custom properties on the app root, so they inherit into the tree's shadow root and follow
 * the light and dark themes on their own; `color-scheme` additionally switches the tree's
 * built-in `light-dark()` colors, such as the file-type icon colors.
 */
export function treeThemeStyle(scheme: "light" | "dark"): CSSProperties {
  return {
    colorScheme: scheme,
    "--trees-bg-override": "var(--sidebar)",
    "--trees-fg-override": "var(--sidebar-foreground)",
    "--trees-fg-muted-override": "var(--muted-foreground)",
    "--trees-bg-muted-override": "var(--sidebar-accent)",
    "--trees-selected-bg-override": "var(--sidebar-accent)",
    "--trees-selected-fg-override": "var(--sidebar-accent-foreground)",
    "--trees-accent-override": "var(--sidebar-ring)",
    "--trees-focus-ring-color-override": "var(--sidebar-ring)",
    "--trees-selected-focused-border-color-override": "var(--sidebar-ring)",
    "--trees-border-color-override": "var(--sidebar-border)",
    "--trees-indent-guide-bg-override": "var(--sidebar-border)",
    "--trees-input-bg-override": "var(--background)",
    "--trees-scrollbar-thumb-override": "var(--border)",
    "--trees-font-family-override": "var(--aperture-font-sans, system-ui)",
    "--trees-font-size-override": "0.875rem",
    "--trees-border-radius-override": "calc(var(--radius) * 0.8)",
    "--trees-padding-inline-override": "6px",
  } as CSSProperties;
}
