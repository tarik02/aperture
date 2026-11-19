type Canvas = HTMLCanvasElement | OffscreenCanvas;

type Drawable = Exclude<CanvasImageSource, SVGImageElement>;

const context = (canvas: Canvas) =>
  canvas instanceof HTMLCanvasElement ? canvas.getContext("2d") : canvas.getContext("2d");

/**
 * Where frames and tiles are drawn: the canvas that is attached, and while none is, a
 * canvas of its own, so that a canvas attached later starts with the picture as it is.
 * Tiles only tell what changed.
 */
export interface Surface {
  readonly size: () => { width: number; height: number };
  readonly draw: (image: Drawable, x: number, y: number, width: number, height: number) => void;
  readonly attach: (canvas: HTMLCanvasElement) => void;
  readonly detach: () => void;
}

export const makeSurface = (): Surface => {
  let canvas: Canvas | undefined;
  let attached = false;

  return {
    size: () => ({ width: canvas?.width ?? 0, height: canvas?.height ?? 0 }),
    draw: (image, x, y, width, height) => {
      if (canvas === undefined && typeof OffscreenCanvas !== "undefined") {
        canvas = new OffscreenCanvas(width, height);
      }
      const onto = canvas;
      if (onto === undefined) {
        return;
      }
      // Sizing a canvas clears it, also to the size it has.
      if (onto.width !== width || onto.height !== height) {
        onto.width = width;
        onto.height = height;
      }
      context(onto)?.drawImage(image, x, y);
    },
    attach: (element) => {
      const kept = canvas;
      // A canvas without pixels cannot be drawn from.
      if (kept !== undefined && kept !== element && kept.width > 0 && kept.height > 0) {
        element.width = kept.width;
        element.height = kept.height;
        context(element)?.drawImage(kept, 0, 0);
      }
      canvas = element;
      attached = true;
    },
    detach: () => {
      if (!attached) {
        return;
      }
      const shown = canvas;
      canvas = undefined;
      attached = false;
      const kept = typeof OffscreenCanvas !== "undefined";
      if (shown === undefined || !kept || shown.width === 0 || shown.height === 0) {
        return;
      }
      canvas = new OffscreenCanvas(shown.width, shown.height);
      context(canvas)?.drawImage(shown, 0, 0);
    },
  };
};
