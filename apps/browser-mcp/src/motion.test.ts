import { describe, expect, it } from "vite-plus/test";
import { pathAt, travelMs } from "./motion.ts";

describe("travelMs", () => {
  it("jumps for instant motion and for a pointer that is already there", () => {
    expect(travelMs("instant", 500)).toBe(0);
    expect(travelMs("natural", 0.2)).toBe(0);
  });

  it("takes a fixed duration whatever the distance", () => {
    expect(travelMs({ durationMs: 800 }, 5)).toBe(800);
  });
});

describe("pathAt", () => {
  const max = { x: 99, y: 99 };

  it("starts and ends exactly at its endpoints", () => {
    const path = pathAt({ x: 10, y: 10 }, { x: 90, y: 40 }, "natural", max);
    expect(path(0)).toEqual({ x: 10, y: 10 });
    expect(path(1)).toEqual({ x: 90, y: 40 });
  });

  it("bends away from the straight line, but not for short moves", () => {
    const from = { x: 0, y: 50 };
    const to = { x: 90, y: 50 };
    expect(pathAt(from, to, "natural", max)(0.5).y).not.toBeCloseTo(50);
    expect(pathAt(from, { x: 5, y: 50 }, "natural", max)(0.5).y).toBeCloseTo(50);
  });

  it("never leaves the surface, even where the bend would", () => {
    const path = pathAt({ x: 0, y: 0 }, { x: 99, y: 0 }, "natural", max);
    // Unclamped, the bend would put the middle of this path above the surface.
    expect(pathAt({ x: 0, y: 50 }, { x: 99, y: 50 }, "natural", max)(0.5).y).not.toBeCloseTo(50);
    for (let t = 0; t <= 1; t += 0.05) {
      const point = path(t);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(99);
    }
  });
});
