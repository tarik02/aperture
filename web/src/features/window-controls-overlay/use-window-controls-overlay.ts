import { useEffect } from "react";
import { watchWindowControlsOverlay } from "#/features/window-controls-overlay/window-controls-overlay.ts";

export function useWindowControlsOverlay() {
  useEffect(() => watchWindowControlsOverlay(), []);
}
