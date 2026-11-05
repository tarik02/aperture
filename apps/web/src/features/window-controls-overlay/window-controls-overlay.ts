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
// The browser paints its caption strip over the page, so its color has to match the surface at
// the top of the page: the sidebar when a titlebar is on screen, otherwise the page background.
const titlebarSelector = "[data-app-titlebar], [data-workbench-titlebar]";

export function getWindowControlsOverlay() {
  return navigator.windowControlsOverlay ?? null;
}

function setThemeColor(value: string | null) {
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

/** The theme color of the surface the caption strip sits on. */
function surfaceThemeColor() {
  const token = document.querySelector(titlebarSelector) ? "--sidebar" : "--background";
  const value = getComputedStyle(document.documentElement).getPropertyValue(token);
  return resolveCssColor(value.trim());
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
  const readDefaultThemeColor = () =>
    document.querySelector<HTMLMetaElement>(themeColorSelector)?.content ?? null;
  // The head can mount after this effect in SPA mode, so remember its value before overriding it.
  let defaultThemeColor = readDefaultThemeColor();

  function updateThemeColor() {
    defaultThemeColor ??= readDefaultThemeColor();
    if (!overlay?.visible) {
      setThemeColor(defaultThemeColor);
      return;
    }
    const color = surfaceThemeColor();
    if (color !== null) {
      setThemeColor(color);
    }
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

  // The meta is owned by the router head; re-assert the color if something rewrites it.
  const headObserver = new MutationObserver(updateThemeColor);
  headObserver.observe(document.head, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["content"],
  });

  // The workbench mounts its titlebar after connecting, which swaps the surface under the strip
  // without a theme or geometry change. Coalesce the DOM churn to one check per frame.
  let surfaceHasTitlebar = document.querySelector(titlebarSelector) !== null;
  let surfaceFrame = 0;
  const surfaceObserver = new MutationObserver(() => {
    if (surfaceFrame !== 0) {
      return;
    }
    surfaceFrame = requestAnimationFrame(() => {
      surfaceFrame = 0;
      const next = document.querySelector(titlebarSelector) !== null;
      if (next === surfaceHasTitlebar) {
        return;
      }
      surfaceHasTitlebar = next;
      updateThemeColor();
    });
  });
  surfaceObserver.observe(document.body, { childList: true, subtree: true });

  overlay.addEventListener("geometrychange", handleGeometryChange);
  window.addEventListener("resize", updateClasses);

  return () => {
    overlay.removeEventListener("geometrychange", handleGeometryChange);
    window.removeEventListener("resize", updateClasses);
    themeObserver.disconnect();
    headObserver.disconnect();
    surfaceObserver.disconnect();
    if (surfaceFrame !== 0) {
      cancelAnimationFrame(surfaceFrame);
    }
    root.classList.remove(...WINDOW_CONTROLS_OVERLAY_CLASSES);
    setThemeColor(defaultThemeColor);
  };
}
