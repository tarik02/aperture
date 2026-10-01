import net from "node:net";
import type { Page } from "playwright-core";
import {
  attentionPathAt,
  clamp,
  easeInOut,
  pathAt,
  travelMs,
  type Motion,
  type Point,
} from "./motion.ts";

export type Button = "left" | "right" | "middle";
export type Modifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

export interface ClickOptions {
  button: Button;
  count: number;
  modifiers: Modifier[];
  arrivalDwellMs: number;
  holdMs: number;
  motion: Motion;
}

export interface AttentionOptions {
  radius: number;
  loops: number;
  durationMs: number;
  motion: Motion;
}

/** What a pointer needs from the thing that moves it; points are in its own pixels. */
export interface Device {
  move(to: Point, signal?: AbortSignal): Promise<void>;
  /** `count` is which click of a multi-click this is. */
  down(button: Button, count: number, signal?: AbortSignal): Promise<void>;
  up(button: Button, count: number, signal?: AbortSignal): Promise<void>;
  key(modifier: Modifier, pressed: boolean, signal?: AbortSignal): Promise<void>;
  wheel(deltaX: number, deltaY: number, signal?: AbortSignal): Promise<void>;
}

/** Sends one command to the compositor's control socket and returns its "ok" reply. */
export function sendCommand(socket: string, line: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket);
    let reply = "";
    const abort = () => connection.destroy(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    connection.setTimeout(5000, () =>
      connection.destroy(new Error("compositor control timed out")),
    );
    connection.on("connect", () => connection.write(`${line}\n`));
    connection.on("data", (chunk) => {
      reply += chunk;
      if (reply.includes("\n")) connection.end();
    });
    connection.on("error", reject);
    connection.on("close", () => {
      signal?.removeEventListener("abort", abort);
      const trimmed = reply.trim();
      if (trimmed.startsWith("ok")) resolve(trimmed);
      else reject(new Error(`compositor rejected "${line}": ${trimmed || "no reply"}`));
    });
  });
}

/** A compositor surface, in the compositor's logical pixels. */
export interface Surface {
  id: number;
  width: number;
  height: number;
}

const buttonCodes = { left: 0x110, right: 0x111, middle: 0x112 };
const keyCodes = { Alt: 56, Control: 29, ControlOrMeta: 29, Meta: 125, Shift: 42 };

/** The compositor's real pointer and keyboard over one surface. */
export function compositorDevice(socket: string, surface: Surface, page: Page): Device {
  const send = (line: string, signal?: AbortSignal) => sendCommand(socket, line, signal);
  let at = { x: 0, y: 0 };
  return {
    async move(to, signal) {
      await send(`motion ${surface.id} ${to.x.toFixed(3)} ${to.y.toFixed(3)}`, signal);
      at = to;
    },
    // Pressing names the position and releasing does not, so a release cannot be refused for it.
    async down(button, _count, signal) {
      await send(
        `button-at ${surface.id} ${at.x.toFixed(3)} ${at.y.toFixed(3)} ${buttonCodes[button]} 1`,
        signal,
      );
    },
    async up(button) {
      await send(`button ${surface.id} ${buttonCodes[button]} 0`);
    },
    async key(modifier, pressed, signal) {
      await send(`key ${surface.id} ${keyCodes[modifier]} ${pressed ? 1 : 0}`, signal);
    },
    // The compositor's wheel overshoots, so the page's own does the scrolling.
    wheel: (deltaX, deltaY, signal) => {
      signal?.throwIfAborted();
      return page.mouse.wheel(deltaX, deltaY);
    },
  };
}

/** Playwright's own mouse and keyboard, for sessions without a compositor. */
export function pageDevice(page: Page): Device {
  return {
    move: (to) => page.mouse.move(to.x, to.y),
    down: (button, count) => page.mouse.down({ button, clickCount: count }),
    up: (button, count) => page.mouse.up({ button, clickCount: count }),
    key: (modifier, pressed) =>
      pressed ? page.keyboard.down(modifier) : page.keyboard.up(modifier),
    wheel: (deltaX, deltaY) => page.mouse.wheel(deltaX, deltaY),
  };
}

const frameMs = 1000 / 60;
// A drag needs motion after the press for HTML5 drag and drop to start.
const dragNudge = 6;
// Pause between clicks of a multi-click; it keeps three clicks inside the double-click interval.
const clickGapMs = 60;

const sleep = (ms: number, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
};
const round = (value: number) => Math.round(value * 10) / 10;
const twice = async (action: () => Promise<unknown>) => {
  await action().catch(action);
};

// Where the pointer last was on each surface, so the next glide starts there.
const positions = new Map<number, Point>();
// Releases for every button and modifier held right now, so the host can let go on exit.
const held = new Set<() => Promise<unknown>>();

/** Lets go of everything held; for a host that is going away mid-gesture. */
export async function releaseAll() {
  await Promise.all([...held].map((release) => release().catch(() => {})));
}

/** What a gesture did, with absolute wall-clock ms (`t`) and positions in device pixels. */
export interface Gesture {
  start: number;
  end: number;
  hold: number;
  path: [t: number, x: number, y: number][];
  clicks: { t: number; x: number; y: number; button: Button; count: number }[];
  scroll?: { t: number; deltaX: number; deltaY: number; x: number; y: number };
}

/**
 * Moves a device like a hand would: an eased glide, a rest, then press and release.
 * Whatever fails, buttons and modifiers it pressed are released.
 */
export class Pointer {
  readonly record: Gesture = { start: 0, end: 0, hold: 0, path: [], clicks: [] };
  private readonly device: Device;
  private readonly surface?: Surface;
  private readonly scale: Point;
  private readonly max: Point;
  private readonly signal?: AbortSignal;
  private at: Point = { x: 0, y: 0 };

  /** Without a surface the device is a plain mouse: no scaling, and every move is a jump. */
  constructor(
    device: Device,
    surface?: Surface,
    viewport?: { width: number; height: number },
    signal?: AbortSignal,
  ) {
    this.device = device;
    this.surface = surface;
    this.signal = signal;
    this.scale =
      surface && viewport
        ? { x: surface.width / viewport.width, y: surface.height / viewport.height }
        : { x: 1, y: 1 };
    // The last pixel column is width - 1; a pointer at width would be on the neighbouring surface.
    this.max = surface
      ? { x: Math.max(surface.width - 1, 0), y: Math.max(surface.height - 1, 0) }
      : { x: Infinity, y: Infinity };
  }

  private toDevice(point: Point): Point {
    return {
      x: clamp(point.x * this.scale.x, this.max.x),
      y: clamp(point.y * this.scale.y, this.max.y),
    };
  }

  private async place(point: Point) {
    await this.device.move(point, this.signal);
    this.at = point;
    if (this.surface) positions.set(this.surface.id, point);
    this.record.path.push([Date.now(), round(point.x), round(point.y)]);
  }

  private async travel(to: Point, motion: Motion) {
    const { surface } = this;
    if (surface) {
      const known = positions.get(surface.id);
      const from = known ?? { x: surface.width / 2, y: surface.height / 2 };
      const duration = travelMs(motion, Math.hypot(to.x - from.x, to.y - from.y));
      if (duration > 0) {
        if (!known) await this.place(from);
        const path = pathAt(from, to, motion, this.max);
        const began = performance.now();
        for (;;) {
          await sleep(frameMs, this.signal);
          const progress = (performance.now() - began) / duration;
          if (progress >= 1) break;
          await this.place(path(progress));
        }
      }
    }
    await this.place(to);
  }

  async glide(to: Point, motion: Motion) {
    this.record.start ||= Date.now();
    await this.travel(this.toDevice(to), motion);
    this.record.end = Date.now();
  }

  /** Approaches an area, traces a smooth orbit around it, then settles at its centre. */
  async attention(center: Point, { radius, loops, durationMs, motion }: AttentionOptions) {
    this.record.start ||= Date.now();
    const at = this.toDevice(center);
    if (!this.surface || durationMs <= 0) {
      await this.travel(at, motion);
      this.record.end = Date.now();
      return;
    }

    const orbitRadius = {
      x: Math.min(radius * this.scale.x, at.x, this.max.x - at.x),
      y: Math.min(radius * this.scale.y * 0.82, at.y, this.max.y - at.y),
    };
    if (orbitRadius.x < 1 || orbitRadius.y < 1) {
      await this.travel(at, motion);
      this.record.end = Date.now();
      return;
    }

    const orbit = attentionPathAt(at, orbitRadius, loops, this.max);
    await this.travel(orbit(0), motion);
    const began = performance.now();
    for (;;) {
      await sleep(frameMs, this.signal);
      const progress = Math.min((performance.now() - began) / durationMs, 1);
      await this.place(orbit(progress));
      if (progress >= 1) break;
    }
    await this.travel(at, motion);
    this.record.end = Date.now();
  }

  /**
   * Runs the action between a press and its release. The release is registered before the
   * press is sent, so a press that fails after the device took it is still let go.
   */
  private async pressed(
    press: () => Promise<void>,
    release: () => Promise<void>,
    act: () => Promise<void>,
  ) {
    const undo = () => twice(release);
    held.add(undo);
    try {
      await press();
      await act();
    } finally {
      await undo().catch(() => {});
      held.delete(undo);
    }
  }

  private async holding(modifiers: Modifier[], action: () => Promise<void>) {
    const [modifier, ...rest] = new Set(modifiers);
    if (!modifier) return action();
    await this.pressed(
      () => this.device.key(modifier, true, this.signal),
      () => this.device.key(modifier, false),
      () => this.holding(rest, action),
    );
  }

  private press(button: Button, count: number, action: () => Promise<void>) {
    return this.pressed(
      async () => {
        await this.device.down(button, count, this.signal);
        this.record.clicks.push({
          t: Date.now(),
          x: round(this.at.x),
          y: round(this.at.y),
          button,
          count,
        });
      },
      () => this.device.up(button, count),
      action,
    );
  }

  async click(
    at: Point,
    { button, count, modifiers, arrivalDwellMs, holdMs, motion }: ClickOptions,
  ) {
    this.record.start ||= Date.now();
    this.record.hold = holdMs;
    await this.travel(this.toDevice(at), motion);
    await sleep(arrivalDwellMs, this.signal);
    await this.holding(modifiers, async () => {
      for (let index = 1; index <= count; index++) {
        await this.press(button, index, () => sleep(holdMs, this.signal));
        if (index < count) await sleep(clickGapMs, this.signal);
      }
    });
    this.record.end = Date.now();
  }

  async drag(
    from: Point,
    to: Point,
    { arrivalDwellMs, holdMs, motion }: { arrivalDwellMs: number; holdMs: number; motion: Motion },
  ) {
    this.record.start ||= Date.now();
    this.record.hold = holdMs;
    const start = this.toDevice(from);
    const end = this.toDevice(to);
    await this.travel(start, motion);
    await sleep(arrivalDwellMs, this.signal);
    await this.press("left", 1, async () => {
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      if (travelMs(motion, distance) <= 0 && distance > dragNudge) {
        await this.place({
          x: start.x + ((end.x - start.x) / distance) * dragNudge,
          y: start.y + ((end.y - start.y) / distance) * dragNudge,
        });
        await sleep(frameMs, this.signal);
      }
      await this.travel(end, motion);
      await sleep(holdMs, this.signal);
    });
    this.record.end = Date.now();
  }

  /** Wheels where the pointer already is. */
  async scroll(deltaX: number, deltaY: number, motion: Motion) {
    this.record.start ||= Date.now();
    this.record.scroll = {
      t: Date.now(),
      deltaX,
      deltaY,
      x: round(this.at.x),
      y: round(this.at.y),
    };
    const duration = travelMs(motion, Math.hypot(deltaX, deltaY));
    if (duration <= 0) {
      await this.device.wheel(deltaX, deltaY, this.signal);
    } else {
      const began = performance.now();
      let previous = 0;
      for (;;) {
        await sleep(frameMs, this.signal);
        const progress = Math.min((performance.now() - began) / duration, 1);
        const eased = easeInOut(progress);
        await this.device.wheel(
          deltaX * (eased - previous),
          deltaY * (eased - previous),
          this.signal,
        );
        previous = eased;
        if (progress >= 1) break;
      }
    }
    this.record.end = Date.now();
  }
}
