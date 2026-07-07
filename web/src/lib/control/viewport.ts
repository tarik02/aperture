export type ViewportPreset = {
  id: string;
  label: string;
  width: number;
  height: number;
};

export const VIEWPORT_PRESETS: ViewportPreset[] = [
  { id: "1280x720", label: "1280×720", width: 1280, height: 720 },
  { id: "1440x900", label: "1440×900", width: 1440, height: 900 },
  { id: "1920x1080", label: "1920×1080", width: 1920, height: 1080 },
  { id: "2560x1440", label: "2560×1440", width: 2560, height: 1440 },
  { id: "768x1024", label: "768×1024", width: 768, height: 1024 },
  { id: "390x844", label: "390×844", width: 390, height: 844 },
];

export const DEFAULT_VIEWPORT = VIEWPORT_PRESETS[0];

export const STALE_FRAME_MS = 3000;

export type RenderMetrics = {
  scale: number;
  offsetX: number;
  offsetY: number;
  renderedWidth: number;
  renderedHeight: number;
};

export function computeRenderMetrics(
  containerWidth: number,
  containerHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): RenderMetrics {
  if (viewportWidth <= 0 || viewportHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
    return {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      renderedWidth: containerWidth,
      renderedHeight: containerHeight,
    };
  }

  const scale = Math.min(containerWidth / viewportWidth, containerHeight / viewportHeight);
  const renderedWidth = viewportWidth * scale;
  const renderedHeight = viewportHeight * scale;

  return {
    scale,
    offsetX: (containerWidth - renderedWidth) / 2,
    offsetY: (containerHeight - renderedHeight) / 2,
    renderedWidth,
    renderedHeight,
  };
}

export function mapClientToViewport(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } | null {
  const metrics = computeRenderMetrics(rect.width, rect.height, viewportWidth, viewportHeight);
  const localX = clientX - rect.left - metrics.offsetX;
  const localY = clientY - rect.top - metrics.offsetY;

  if (
    localX < 0 ||
    localY < 0 ||
    localX > metrics.renderedWidth ||
    localY > metrics.renderedHeight
  ) {
    return null;
  }

  return {
    x: Math.round(localX / metrics.scale),
    y: Math.round(localY / metrics.scale),
  };
}
