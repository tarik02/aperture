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
  return navigator.windowControlsOverlay ?? null;
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

export function watchWindowControlsOverlay() {
  const overlay = getWindowControlsOverlay();
  const root = document.documentElement;

  function updateClasses() {
    const classes = windowControlsOverlayClasses(overlay, window.innerWidth);

    root.classList.remove(...WINDOW_CONTROLS_OVERLAY_CLASSES);
    if (classes.length > 0) {
      root.classList.add(...classes);
    }
  }

  updateClasses();

  if (!overlay) {
    return () => root.classList.remove(...WINDOW_CONTROLS_OVERLAY_CLASSES);
  }

  const handleGeometryChange = (_event: WindowControlsOverlayGeometryChangeEvent) =>
    updateClasses();

  overlay.addEventListener("geometrychange", handleGeometryChange);
  window.addEventListener("resize", updateClasses);

  return () => {
    overlay.removeEventListener("geometrychange", handleGeometryChange);
    window.removeEventListener("resize", updateClasses);
    root.classList.remove(...WINDOW_CONTROLS_OVERLAY_CLASSES);
  };
}
