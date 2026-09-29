import net from "node:net";
import type { Page } from "playwright-core";
import { clamp, pathAt, travelMs, type Motion, type Point } from "./motion.ts";

export type Button = "left" | "right" | "middle";
export type Modifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

export interface ClickOptions {
  button: Button;
  count: number;
  modifiers: Modifier[];
  holdMs: number;
  motion: Motion;
}

/** Produces the pointer side of a gesture; points are viewport CSS pixels. */
export interface Pointer {
  glide(to: Point, motion: Motion): Promise<void>;
  click(at: Point, options: ClickOptions): Promise<void>;
  drag(from: Point, to: Point, options: { holdMs: number; motion: Motion }): Promise<void>;
}

/** Sends one command to the compositor's control socket and returns its "ok" reply. */
export function sendCommand(socket: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket);
    let reply = "";
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
const frameMs = 1000 / 60;
// Time the pointer rests on a destination before pressing, so the page sees the hover.
const dwellMs = 60;
const instantDwellMs = 20;
// A drag needs motion after the press for HTML5 drag and drop to start.
const dragNudge = 6;
// Pause between clicks of a multi-click; it keeps three clicks inside the double-click interval.
const clickGapMs = 60;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const twice = async (action: () => Promise<unknown>) => {
  await action().catch(action);
};

// Where the pointer last was on each surface, so the next glide starts there.
const positions = new Map<number, Point>();

export interface Gesture {
  path: [ms: number, x: number, y: number][];
  clicks: { ms: number; x: number; y: number; button: Button; count: number }[];
}

/**
 * Glides the compositor's real pointer over one surface and presses real buttons and
 * keys. Whatever fails, buttons and modifiers it pressed are released.
 */
export class CompositorPointer implements Pointer {
  readonly record: Gesture = { path: [], clicks: [] };
  private readonly started = Date.now();
  private readonly max: Point;
  private readonly socket: string;
  private readonly surface: Surface;
  private readonly scale: number;

  constructor(socket: string, surface: Surface, scale: number) {
    this.socket = socket;
    this.surface = surface;
    this.scale = scale;
    // The last pixel column is width - 1; a pointer at width would be on the neighbouring surface.
    this.max = { x: Math.max(surface.width - 1, 0), y: Math.max(surface.height - 1, 0) };
  }

  private send(line: string) {
    return sendCommand(this.socket, line);
  }

  private toSurface(point: Point): Point {
    return {
      x: clamp(point.x * this.scale, this.max.x),
      y: clamp(point.y * this.scale, this.max.y),
    };
  }

  private async place(point: Point) {
    await this.send(`motion ${this.surface.id} ${point.x.toFixed(3)} ${point.y.toFixed(3)}`);
    positions.set(this.surface.id, point);
    this.record.path.push([Date.now() - this.started, round(point.x), round(point.y)]);
  }

  private async travel(to: Point, motion: Motion) {
    const known = positions.get(this.surface.id);
    const from = known
      ? { x: clamp(known.x, this.max.x), y: clamp(known.y, this.max.y) }
      : { x: this.surface.width / 2, y: this.surface.height / 2 };
    if (from.x !== known?.x || from.y !== known?.y) await this.place(from);
    const duration = travelMs(motion, Math.hypot(to.x - from.x, to.y - from.y));
    if (duration > 0) {
      const path = pathAt(from, to, motion, this.max);
      const began = performance.now();
      for (;;) {
        await sleep(frameMs);
        const progress = (performance.now() - began) / duration;
        if (progress >= 1) break;
        await this.place(path(progress));
      }
    }
    await this.place(to);
  }

  async glide(to: Point, motion: Motion) {
    await this.travel(this.toSurface(to), motion);
  }

  private key(code: number, pressed: boolean) {
    return this.send(`key ${this.surface.id} ${code} ${pressed ? 1 : 0}`);
  }

  private async holding(modifiers: Modifier[], action: () => Promise<void>) {
    const held: number[] = [];
    try {
      for (const code of new Set(modifiers.map((modifier) => keyCodes[modifier]))) {
        await this.key(code, true);
        held.push(code);
      }
      await action();
    } finally {
      for (const code of held.reverse()) await twice(() => this.key(code, false)).catch(() => {});
    }
  }

  /** Holds a button while the action runs. The release names no coordinates, so it cannot be refused for them. */
  private async pressed(button: Button, at: Point, action: () => Promise<void>) {
    const code = buttonCodes[button];
    await this.send(`button-at ${this.surface.id} ${at.x.toFixed(3)} ${at.y.toFixed(3)} ${code} 1`);
    try {
      await action();
    } finally {
      await twice(() => this.send(`button ${this.surface.id} ${code} 0`));
    }
  }

  async click(at: Point, { button, count, modifiers, holdMs, motion }: ClickOptions) {
    const to = this.toSurface(at);
    await this.travel(to, motion);
    await sleep(motion === "instant" ? instantDwellMs : dwellMs);
    await this.holding(modifiers, async () => {
      for (let index = 1; index <= count; index++) {
        await this.pressed(button, to, async () => {
          this.record.clicks.push({
            ms: Date.now() - this.started,
            x: round(to.x),
            y: round(to.y),
            button,
            count: index,
          });
          await sleep(holdMs);
        });
        if (index < count) await sleep(clickGapMs);
      }
    });
  }

  async drag(from: Point, to: Point, { holdMs, motion }: { holdMs: number; motion: Motion }) {
    const start = this.toSurface(from);
    const end = this.toSurface(to);
    await this.travel(start, motion);
    await sleep(dwellMs);
    await this.pressed("left", start, async () => {
      this.record.clicks.push({
        ms: Date.now() - this.started,
        x: round(start.x),
        y: round(start.y),
        button: "left",
        count: 1,
      });
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      if (travelMs(motion, distance) <= 0 && distance > dragNudge) {
        await this.place({
          x: start.x + ((end.x - start.x) / distance) * dragNudge,
          y: start.y + ((end.y - start.y) / distance) * dragNudge,
        });
        await sleep(frameMs);
      }
      await this.travel(end, motion);
      await sleep(Math.max(holdMs, dwellMs));
    });
  }
}

/** Playwright's own mouse, for sessions without a compositor. Motion does not apply. */
export class PagePointer implements Pointer {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async glide(to: Point) {
    await this.page.mouse.move(to.x, to.y);
  }

  private async holding(modifiers: Modifier[], action: () => Promise<void>) {
    const held: Modifier[] = [];
    try {
      for (const modifier of new Set(modifiers)) {
        await this.page.keyboard.down(modifier);
        held.push(modifier);
      }
      await action();
    } finally {
      for (const modifier of held.reverse()) await this.page.keyboard.up(modifier).catch(() => {});
    }
  }

  async click(at: Point, { button, count, modifiers, holdMs }: ClickOptions) {
    await this.glide(at);
    await this.holding(modifiers, () =>
      this.page.mouse.click(at.x, at.y, { button, clickCount: count, delay: holdMs }),
    );
  }

  async drag(from: Point, to: Point, { holdMs }: { holdMs: number }) {
    await this.glide(from);
    await this.page.mouse.down();
    try {
      await this.page.mouse.move(to.x, to.y, { steps: 5 });
      await sleep(holdMs);
    } finally {
      await this.page.mouse.up();
    }
  }
}

const round = (value: number) => Math.round(value * 10) / 10;
