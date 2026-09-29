import http from "node:http";
import type { Page } from "playwright-core";
import type { Context, Response, Tab, ToolDefinition } from "playwright-core/lib/coreBundle";
import { z } from "playwright-core/lib/utilsBundle";
import type { ZodObject, ZodRawShape, infer as Infer } from "zod";
import type { Point } from "./motion.ts";
import { targetIdOf } from "./actions.ts";
import { CompositorPointer, PagePointer, type Pointer, type Surface } from "./pointer.ts";

/** Where the compositor is, when there is one. */
export interface CompositorConfig {
  /** The compositor control socket. */
  socket: string;
  /** The wrapper's target list, which maps a browser target to its compositor surface. */
  targetsUrl: string;
}

const targetHelp = "Snapshot element ref, or a unique locator such as a CSS selector.";
const place = {
  target: z.string().optional().describe(targetHelp),
  element: z.string().optional().describe("Human-readable element description"),
  x: z.number().optional().describe("X in viewport CSS pixels; give x and y instead of a target"),
  y: z.number().optional().describe("Y in viewport CSS pixels"),
};
const endpoint = (which: "Start" | "End") => ({
  target: z.string().optional().describe(`${which}: ${targetHelp}`),
  element: z.string().optional().describe(`${which}: human-readable element description`),
  x: z
    .number()
    .optional()
    .describe(`${which} X in viewport CSS pixels; give x and y instead of a target`),
  y: z.number().optional().describe(`${which} Y in viewport CSS pixels`),
});
const startFields = endpoint("Start");
const endFields = endpoint("End");
const motion = z
  .union([
    z.enum(["natural", "fast", "instant"]),
    z.object({ durationMs: z.number().min(0).max(30_000) }),
  ])
  .optional()
  .describe(
    'How the pointer travels: "natural" (default; eased, slightly curved), "fast", "instant", or {durationMs}. Only sessions with a compositor show it; others ignore it.',
  );
const holdMs = z.number().min(0).max(10_000).optional();

interface Spot {
  target?: string;
  element?: string;
  x?: number;
  y?: number;
}

/** A gesture, as the tool result's `_meta.aperture.gesture` reports it. */
interface GestureRecord {
  kind: "click" | "move" | "drag" | "scroll";
  tool: string;
  targetId: string;
  start: number;
  end: number;
  hold: number;
  /** Surface pixels at wall-clock epoch milliseconds: [t, x, y]. */
  path: [t: number, x: number, y: number][];
  clicks: (Omit<CompositorPointer["record"]["clicks"][number], "ms"> & { t: number })[];
  scroll?: { deltaX: number; deltaY: number; x: number; y: number };
}

interface Run {
  tab: Tab;
  page: Page;
  pointer: Pointer;
  size: { width: number; height: number };
}

// Not fetch: on Node 26 it takes seconds to reach the loopback wrapper.
function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

export function pointerTools(compositor?: CompositorConfig): ToolDefinition[] {
  async function surfaceOf(targetId: string): Promise<Surface | undefined> {
    if (!compositor) return undefined;
    try {
      const targets = (await getJson(compositor.targetsUrl)) as {
        targetId: string;
        surfaceId: number;
        state: string;
        viewport: { width: number; height: number };
      }[];
      const target = targets.find(
        (candidate) => candidate.targetId === targetId && candidate.state === "ready",
      );
      return (
        target && {
          id: target.surfaceId,
          width: target.viewport.width,
          height: target.viewport.height,
        }
      );
    } catch {
      return undefined;
    }
  }

  /**
   * The point a target or coordinates name, in viewport CSS pixels. A target must pass
   * Playwright's actionability checks first (scrolled into view; visible, stable, not
   * covered, and for a click enabled), without acting on it.
   */
  async function locate({ tab, size }: Run, spot: Spot, click = false): Promise<Point> {
    if (spot.target) {
      const { locator } = await tab.targetLocator({ target: spot.target, element: spot.element });
      const options = { trial: true, ...tab.actionTimeoutOptions };
      await (click ? locator.click(options) : locator.hover(options));
      const box = await locator.boundingBox();
      if (!box) throw new Error(`"${spot.target}" has no visible box.`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    if (spot.x === undefined || spot.y === undefined) {
      throw new Error("Give a target (snapshot ref or selector), or both x and y.");
    }
    if (spot.x < 0 || spot.y < 0 || spot.x >= size.width || spot.y >= size.height) {
      throw new Error(
        `(${spot.x}, ${spot.y}) is outside the ${size.width}x${size.height} viewport.`,
      );
    }
    return { x: spot.x, y: spot.y };
  }

  /** Defines a pointer tool; `act` runs one gesture on the current tab. */
  function define<Shape extends ZodRawShape>(
    name: string,
    kind: GestureRecord["kind"],
    description: string,
    shape: Shape,
    act: (run: Run, params: Infer<ZodObject<Shape>>) => Promise<Partial<GestureRecord> | void>,
  ): ToolDefinition {
    const handle = async (
      context: Context,
      params: Infer<ZodObject<Shape>>,
      response: Response,
    ) => {
      const tab = await context.ensureTab();
      if (tab.modalStates().length) {
        throw new Error(`A dialog is open; handle it with browser_handle_dialog before ${name}.`);
      }
      const { page } = tab;
      const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const targetId = await targetIdOf(page);
      const surface = await surfaceOf(targetId);
      const pointer =
        surface && compositor
          ? new CompositorPointer(compositor.socket, surface, surface.width / size.width)
          : new PagePointer(page);
      const start = Date.now();
      response.setIncludeSnapshot();
      const extra = await act({ tab, page, pointer, size }, params);
      // The pointer times its records from when it was made, which is `start`.
      const record = pointer instanceof CompositorPointer ? pointer.record : undefined;
      const gesture: GestureRecord = {
        kind,
        tool: name,
        targetId,
        start,
        end: Date.now(),
        hold: 0,
        path: (record?.path ?? []).map(([ms, x, y]) => [start + ms, x, y]),
        clicks: (record?.clicks ?? []).map(({ ms, ...click }) => ({ t: start + ms, ...click })),
        ...extra,
      };
      const serialize = response.serialize.bind(response);
      response.serialize = async () => ({
        ...(await serialize()),
        _meta: { aperture: { gesture } },
      });
    };
    return {
      capability: "core",
      schema: {
        name,
        title: name.replace("browser_", "").replace(/^./, (c) => c.toUpperCase()),
        description,
        inputSchema: z.object(shape),
        type: "input",
      },
      handle: handle as ToolDefinition["handle"],
    };
  }

  return [
    define(
      "browser_click",
      "click",
      "Click an element by snapshot ref or selector, or a point by x and y. In a live session the visible pointer glides there and presses real buttons.",
      {
        ...place,
        button: z
          .enum(["left", "right", "middle"])
          .optional()
          .describe("Button to click, defaults to left"),
        clickCount: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe("Number of clicks (2 is a double click), defaults to 1"),
        modifiers: z
          .array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"]))
          .optional()
          .describe("Modifier keys to hold during the click"),
        motion,
        holdMs: holdMs.describe(
          "Milliseconds the button stays down for each click, defaults to 45",
        ),
      },
      async (run, params) => {
        const point = await locate(run, params, true);
        const hold = params.holdMs ?? 45;
        await run.tab.waitForCompletion(() =>
          run.pointer.click(point, {
            button: params.button ?? "left",
            count: params.clickCount ?? 1,
            modifiers: params.modifiers ?? [],
            holdMs: hold,
            motion: params.motion ?? "natural",
          }),
        );
        return { hold };
      },
    ),
    define(
      "browser_move",
      "move",
      "Move the pointer over an element or point without clicking, for hover effects.",
      { ...place, motion },
      async (run, params) => {
        const point = await locate(run, params);
        await run.tab.waitForCompletion(() => run.pointer.glide(point, params.motion ?? "natural"));
      },
    ),
    define(
      "browser_drag",
      "drag",
      "Drag with the left button from one element or point to another. Works for HTML5 drag and drop and pointer-event drags.",
      {
        startTarget: startFields.target,
        startElement: startFields.element,
        startX: startFields.x,
        startY: startFields.y,
        endTarget: endFields.target,
        endElement: endFields.element,
        endX: endFields.x,
        endY: endFields.y,
        motion,
        holdMs: holdMs.describe(
          "Milliseconds to hold the button at the destination before releasing",
        ),
      },
      async (run, params) => {
        const from = await locate(run, {
          target: params.startTarget,
          element: params.startElement,
          x: params.startX,
          y: params.startY,
        });
        const to = await locate(run, {
          target: params.endTarget,
          element: params.endElement,
          x: params.endX,
          y: params.endY,
        });
        const hold = params.holdMs ?? 0;
        await run.tab.waitForCompletion(() =>
          run.pointer.drag(from, to, { holdMs: hold, motion: params.motion ?? "natural" }),
        );
        return { hold };
      },
    ),
    define(
      "browser_scroll",
      "scroll",
      "Scroll by exact pixel deltas with the mouse wheel over an element or point (the viewport center by default).",
      {
        ...place,
        deltaX: z
          .number()
          .optional()
          .describe("Horizontal pixels to scroll, positive is right, defaults to 0"),
        deltaY: z
          .number()
          .optional()
          .describe("Vertical pixels to scroll, positive is down, defaults to 0"),
        motion,
      },
      async (run, params) => {
        const { width, height } = run.size;
        const point =
          params.target || params.x !== undefined || params.y !== undefined
            ? await locate(run, params)
            : { x: width / 2, y: height / 2 };
        const deltaX = params.deltaX ?? 0;
        const deltaY = params.deltaY ?? 0;
        await run.tab.waitForCompletion(async () => {
          await run.pointer.glide(point, params.motion ?? "natural");
          // The wheel goes through Playwright either way: the compositor's overshoots.
          await run.page.mouse.move(point.x, point.y);
          await run.page.mouse.wheel(deltaX, deltaY);
        });
        return { scroll: { deltaX, deltaY, x: point.x, y: point.y } };
      },
    ),
  ];
}
