import { useEffect } from "react";

type WindowControlsOverlayHandle = {
  isVisible: () => boolean;
  getTitlebarAreaRect: () => DOMRectReadOnly;
  addEventListener: (type: "geometrychange", listener: EventListener) => void;
  removeEventListener: (type: "geometrychange", listener: EventListener) => void;
};

const WCO_CLASSES = ["wco", "wco-left", "wco-right"];

export function WindowControlsOverlayWatcher() {
  useEffect(() => {
    const overlay = readWindowControlsOverlay();
    const root = document.documentElement;

    function updateClasses() {
      root.classList.remove(...WCO_CLASSES);

      if (!overlay?.isVisible()) {
        return;
      }

      const rect = overlay.getTitlebarAreaRect();
      root.classList.add("wco");

      if (rect.x > 1) {
        root.classList.add("wco-left");
      }
      if (rect.x + rect.width < window.innerWidth - 1) {
        root.classList.add("wco-right");
      }
    }

    updateClasses();

    if (!overlay) {
      return () => root.classList.remove(...WCO_CLASSES);
    }

    overlay.addEventListener("geometrychange", updateClasses);
    window.addEventListener("resize", updateClasses);

    return () => {
      overlay.removeEventListener("geometrychange", updateClasses);
      window.removeEventListener("resize", updateClasses);
      root.classList.remove(...WCO_CLASSES);
    };
  }, []);

  return null;
}

function readWindowControlsOverlay(): WindowControlsOverlayHandle | null {
  const value = Reflect.get(navigator, "windowControlsOverlay");
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const visible = Reflect.get(value, "visible");
  const getTitlebarAreaRect = Reflect.get(value, "getTitlebarAreaRect");
  const addEventListener = Reflect.get(value, "addEventListener");
  const removeEventListener = Reflect.get(value, "removeEventListener");

  if (
    typeof visible !== "boolean" ||
    typeof getTitlebarAreaRect !== "function" ||
    typeof addEventListener !== "function" ||
    typeof removeEventListener !== "function"
  ) {
    return null;
  }

  return {
    isVisible: () => Reflect.get(value, "visible") === true,
    getTitlebarAreaRect: () => getTitlebarAreaRect.call(value),
    addEventListener: (type, listener) => addEventListener.call(value, type, listener),
    removeEventListener: (type, listener) => removeEventListener.call(value, type, listener),
  };
}
