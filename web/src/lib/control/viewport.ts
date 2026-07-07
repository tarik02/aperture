export type ViewportPreset = {
  id: string;
  label: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
};

export const VIEWPORT_PRESETS: ViewportPreset[] = [
  createViewportPreset(1280, 720, 1),
  createViewportPreset(1440, 900, 1),
  createViewportPreset(1920, 1080, 1),
  createViewportPreset(2560, 1440, 1),
  createViewportPreset(768, 1024, 1),
  createViewportPreset(390, 844, 1),
];

export const DEFAULT_VIEWPORT = VIEWPORT_PRESETS[0];

export const VIEWPORT_DEVICE_SCALE_FACTORS = [1, 1.5, 2, 3] as const;

export const STALE_FRAME_MS = 3000;

export type RenderMetrics = {
  scale: number;
  offsetX: number;
  offsetY: number;
  renderedWidth: number;
  renderedHeight: number;
};

export function createViewportPreset(
  width: number,
  height: number,
  deviceScaleFactor: number,
): ViewportPreset {
  const scaleLabel = formatViewportScale(deviceScaleFactor);
  return {
    id: `${width}x${height}@${scaleLabel}`,
    label: `${width}×${height}`,
    width,
    height,
    deviceScaleFactor,
  };
}

export function formatViewportScale(deviceScaleFactor: number): string {
  return Number.isInteger(deviceScaleFactor)
    ? String(deviceScaleFactor)
    : String(deviceScaleFactor).replace(/0+$/, "").replace(/\.$/, "");
}

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
