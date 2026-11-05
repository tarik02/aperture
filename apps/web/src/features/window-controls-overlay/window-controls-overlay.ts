export type WindowControlsOverlayGeometryChangeEvent = Event & {
  readonly titlebarAreaRect: DOMRectReadOnly;
  readonly visible: boolean;
};

export type WindowControlsOverlay = EventTarget & {
  readonly visible: boolean;
  getTitlebarAreaRect: () => DOMRectReadOnly;
  addEventListener: (
    type: "geometrychange",
    listener: (event: WindowControlsOverlayGeometryChangeEvent) => void,
    options?: AddEventListenerOptions,
  ) => void;
  removeEventListener: (
    type: "geometrychange",
    listener: (event: WindowControlsOverlayGeometryChangeEvent) => void,
    options?: EventListenerOptions,
  ) => void;
};

declare global {
  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay;
  }
}

export const WINDOW_CONTROLS_OVERLAY_CLASSES = ["wco", "wco-left", "wco-right"] as const;

export function getWindowControlsOverlay() {
  return typeof navigator === "undefined" ? null : (navigator.windowControlsOverlay ?? null);
}

export function windowControlsOverlayClasses(
  overlay: WindowControlsOverlay | null,
  viewportWidth: number,
) {
  if (!overlay?.visible) {
    return [];
  }

  const rect = overlay.getTitlebarAreaRect();
  const classes: string[] = ["wco"];

  if (rect.x > 1) {
    classes.push("wco-left");
  }
  if (rect.x + rect.width < viewportWidth - 1) {
    classes.push("wco-right");
  }

  return classes;
}
