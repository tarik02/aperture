export interface Point {
  x: number;
  y: number;
}

/** How the pointer travels: a preset, or a fixed duration. */
export type Motion = "natural" | "fast" | "instant" | { durationMs: number };

const presets = {
  natural: { speed: 1200, min: 220, max: 1400, bend: 0.08 },
  fast: { speed: 3200, min: 60, max: 450, bend: 0.03 },
};

/** Milliseconds a glide of this length takes; 0 means jump. */
export function travelMs(motion: Motion, distance: number): number {
  if (distance < 0.5 || motion === "instant") return 0;
  if (typeof motion === "object") return motion.durationMs;
  const { speed, min, max } = presets[motion];
  return Math.min(max, Math.max(min, (distance / speed) * 1000));
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The eased, slightly bent path from one point to another, as a function of
 * progress 0..1. Points are clamped to the surface so a bend never leaves it.
 */
export function pathAt(from: Point, to: Point, motion: Motion, max: Point): (t: number) => Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const bend = typeof motion === "string" && motion !== "instant" ? presets[motion].bend : 0;
  // Short moves stay straight; a bend would only look like jitter.
  const offset = distance < 8 ? 0 : Math.min(distance * bend, 40) * (dx >= 0 ? 1 : -1);
  const control = {
    x: (from.x + to.x) / 2 - (dy / (distance || 1)) * offset,
    y: (from.y + to.y) / 2 + (dx / (distance || 1)) * offset,
  };
  return (t) => {
    const s = easeInOut(t);
    const a = (1 - s) ** 2;
    const b = 2 * (1 - s) * s;
    const c = s ** 2;
    return {
      x: clamp(a * from.x + b * control.x + c * to.x, max.x),
      y: clamp(a * from.y + b * control.y + c * to.y, max.y),
    };
  };
}

export const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
