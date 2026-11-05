import type { ShellLayout } from "#/lib/shell-layout.ts";
import { useWindowControlsOverlay } from "#/features/window-controls-overlay/use-window-controls-overlay.ts";

export function WindowControlsOverlayWatcher({ layout }: { layout: ShellLayout }) {
  useWindowControlsOverlay(layout);
  return null;
}
