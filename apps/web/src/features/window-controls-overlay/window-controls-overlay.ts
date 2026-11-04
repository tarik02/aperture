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

const themeColorSelector = 'meta[name="theme-color"]';
// The browser paints the titlebar strip in the theme color. It cannot match a transparent
// surface, so use the sidebar token, which is what the strip sits on in both titlebars.
const wcoThemeColorDark = "#171717";
const wcoThemeColorLight = "#fafafa";

export function getWindowControlsOverlay() {
  return navigator.windowControlsOverlay ?? null;
}

function setThemeColor(value: string | null) {
  const meta = document.querySelector<HTMLMetaElement>(themeColorSelector);
  if (!meta) {
    return;
  }
  if (value === null) {
    meta.removeAttribute("content");
  } else {
    meta.content = value;
  }
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
  const defaultThemeColor =
    document.querySelector<HTMLMetaElement>(themeColorSelector)?.content ?? null;

  function updateThemeColor() {
    if (!overlay?.visible) {
      setThemeColor(defaultThemeColor);
      return;
    }
    setThemeColor(
      root.classList.contains("aperture-dark") ? wcoThemeColorDark : wcoThemeColorLight,
    );
  }

  function updateClasses() {
    const classes = windowControlsOverlayClasses(overlay, window.innerWidth);

    root.classList.remove(...WINDOW_CONTROLS_OVERLAY_CLASSES);
    if (classes.length > 0) {
      root.classList.add(...classes);
    }

    updateThemeColor();
  }

  updateClasses();

  if (!overlay) {
    return () => {
      root.classList.remove(...WINDOW_CONTROLS_OVERLAY_CLASSES);
      setThemeColor(defaultThemeColor);
    };
  }

  const handleGeometryChange = (_event: WindowControlsOverlayGeometryChangeEvent) =>
    updateClasses();
  // The theme class can change while the overlay stays the same size.
  const themeObserver = new MutationObserver(updateThemeColor);
  themeObserver.observe(root, { attributes: true, attributeFilter: ["class"] });

  overlay.addEventListener("geometrychange", handleGeometryChange);
  window.addEventListener("resize", updateClasses);

  return () => {
    overlay.removeEventListener("geometrychange", handleGeometryChange);
    window.removeEventListener("resize", updateClasses);
    themeObserver.disconnect();
    root.classList.remove(...WINDOW_CONTROLS_OVERLAY_CLASSES);
    setThemeColor(defaultThemeColor);
  };
}
