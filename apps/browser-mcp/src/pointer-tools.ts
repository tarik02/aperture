import http from "node:http";
import { stripVTControlCharacters } from "node:util";
import type { Page } from "playwright-core";
import type { Context, Response, Tab, ToolDefinition } from "playwright-core/lib/coreBundle";
import type { ZodRawShape } from "zod";
import { z } from "playwright-core/lib/utilsBundle";
import type { Point } from "./motion.ts";
import { targetIdOf } from "./actions.ts";
import { compositorDevice, pageDevice, Pointer, type Surface } from "./pointer.ts";

/** Where the compositor is, when there is one. */
export interface CompositorConfig {
  /** The compositor control socket. */
  socket: string;
  /** The wrapper's target list, which maps a browser target to its compositor surface. */
  targetsUrl: string;
}

// Field names: "target", or "startTarget" for a prefix of "start".
const field = (name: string, prefix: string) =>
  prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name;

const sentence = (text: string) => text[0].toUpperCase() + text.slice(1);

/** The schema fields that name a spot: an element, or viewport coordinates. */
const spot = (prefix = "") => {
  const of = prefix ? `${prefix} ` : "";
  return {
    [field("target", prefix)]: z
      .string()
      .optional()
      .describe(sentence(`${of}snapshot element ref, or a unique locator such as a CSS selector`)),
    [field("element", prefix)]: z
      .string()
      .optional()
      .describe(sentence(`${of}human-readable element description`)),
    [field("x", prefix)]: z
      .number()
      .optional()
      .describe(sentence(`${of}X in viewport CSS pixels; give x and y instead of a target`)),
    [field("y", prefix)]: z
      .number()
      .optional()
      .describe(sentence(`${of}Y in viewport CSS pixels`)),
  };
};
const motion = z
  .union([
    z.enum(["natural", "fast", "instant"]),
    z.object({ durationMs: z.number().min(0).max(30_000) }),
  ])
  .optional()
  .describe(
    'How the pointer travels: "natural" (eased, slightly curved), "fast", "instant" (default without a recording), or {durationMs}. An active recording supplies a visible default. Only sessions with a compositor show it; others ignore it.',
  );
const holdMs = z.number().min(0).max(10_000).optional();
const arrivalDwellMs = z
  .number()
  .min(0)
  .max(10_000)
  .optional()
  .describe("Milliseconds the pointer rests on the destination before pressing");
const ripple = z
  .boolean()
  .optional()
  .describe("Mark this click with a ripple in the recording. Defaults to the recording's ripple.");

type Params = Record<string, any>;

interface Run {
  tab: Tab;
  page: Page;
  pointer: Pointer;
  size: { width: number; height: number };
}

interface FocusRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const targetList = z.array(
  z.object({
    targetId: z.string(),
    surfaceId: z.number(),
    state: z.string(),
    viewport: z.object({ width: z.number(), height: z.number() }),
  }),
);

// Not fetch: on Node 26 it takes seconds to reach the loopback wrapper.
async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    http
      .get(url, { timeout: 2000, ...(signal ? { signal } : {}) }, resolve)
      .on("timeout", function (this: http.ClientRequest) {
        this.destroy(new Error(`${url} timed out`));
      })
      .on("error", reject);
  });
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`${url} answered ${response.statusCode}`);
  }
  let body = "";
  for await (const chunk of response) {
    signal?.throwIfAborted();
    body += chunk;
  }
  return JSON.parse(body);
}

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

export function pointerTools(compositor?: CompositorConfig): ToolDefinition[] {
  /** The surface of a browser target; a new tab takes a moment to get one. */
  async function surfaceOf(targetId: string, signal?: AbortSignal): Promise<Surface | undefined> {
    if (!compositor) return undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await sleep(100, signal);
      let raw: unknown;
      try {
        raw = await getJson(compositor.targetsUrl, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        continue;
      }
      const decoded = targetList.safeParse(raw);
      if (!decoded.success) continue;
      const target = decoded.data.find(
        (candidate) => candidate.targetId === targetId && candidate.state === "ready",
      );
      if (target) {
        return {
          id: target.surfaceId,
          width: target.viewport.width,
          height: target.viewport.height,
        };
      }
    }
    return undefined;
  }

  /**
   * The center of the part of a target inside the viewport, or of the coordinates. A
   * target must pass Playwright's actionability checks first (scrolled into view; visible,
   * stable, not covered, and for a click enabled), without acting on it, unless it is
   * only `peek`ed at.
   */
  async function locate(
    { tab, size }: Run,
    params: Params,
    prefix = "",
    mode: "hover" | "click" | "peek" = "hover",
  ): Promise<Point> {
    const [target, element, x, y] = ["target", "element", "x", "y"].map(
      (name) => params[field(name, prefix)],
    );
    if (target) {
      const { locator } = await tab.targetLocator({ target, element });
      if (mode !== "peek") await locator[mode]({ trial: true, ...tab.actionTimeoutOptions });
      const box = await locator.boundingBox();
      // A tall or wide element only counts where it is on screen.
      const seen = box && {
        left: Math.max(box.x, 0),
        top: Math.max(box.y, 0),
        right: Math.min(box.x + box.width, size.width),
        bottom: Math.min(box.y + box.height, size.height),
      };
      if (!seen || seen.right <= seen.left || seen.bottom <= seen.top) {
        throw new Error(`"${target}" is not visible in the viewport.`);
      }
      return { x: (seen.left + seen.right) / 2, y: (seen.top + seen.bottom) / 2 };
    }
    if (x === undefined || y === undefined) {
      throw new Error("Give a target (snapshot ref or selector), or both x and y.");
    }
    if (x < 0 || y < 0 || x >= size.width || y >= size.height) {
      throw new Error(`(${x}, ${y}) is outside the ${size.width}x${size.height} viewport.`);
    }
    return { x, y };
  }

  async function focusRect(run: Run, params: Params): Promise<FocusRect> {
    if (params.target) {
      const { locator } = await run.tab.targetLocator({
        target: params.target,
        element: params.element,
      });
      const box = await locator.boundingBox();
      if (!box) throw new Error(`"${params.target}" is not visible in the viewport.`);
      const left = Math.max(box.x, 0);
      const top = Math.max(box.y, 0);
      const right = Math.min(box.x + box.width, run.size.width);
      const bottom = Math.min(box.y + box.height, run.size.height);
      if (right <= left || bottom <= top) {
        throw new Error(`"${params.target}" is not visible in the viewport.`);
      }
      return { x: left, y: top, width: right - left, height: bottom - top };
    }
    const values = [params.x, params.y, params.width, params.height];
    if (values.some((value) => typeof value !== "number")) {
      throw new Error("Give a target, or x, y, width and height.");
    }
    const rect = {
      x: params.x as number,
      y: params.y as number,
      width: params.width as number,
      height: params.height as number,
    };
    if (
      rect.x < 0 ||
      rect.y < 0 ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.x + rect.width > run.size.width ||
      rect.y + rect.height > run.size.height
    ) {
      throw new Error("The focus rectangle must be inside the viewport.");
    }
    return rect;
  }

  /** Defines a pointer tool; `act` runs one gesture on the current tab. */
  function define(
    name: string,
    description: string,
    shape: ZodRawShape,
    act: (run: Run, params: Params) => Promise<Record<string, unknown> | void>,
  ): ToolDefinition {
    return {
      capability: "core",
      schema: { name, title: name, description, inputSchema: z.object(shape), type: "input" },
      handle: async (
        context: Context,
        params: Params,
        response: Response,
        signal?: AbortSignal,
      ) => {
        try {
          signal?.throwIfAborted();
          const tab = await context.ensureTab();
          if (tab.modalStates().length) {
            throw new Error(
              `A dialog is open; handle it with browser_handle_dialog before ${name}.`,
            );
          }
          const { page } = tab;
          const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          const targetId = await targetIdOf(page);
          const surface = await surfaceOf(targetId, signal);
          const pointer =
            surface && compositor
              ? new Pointer(
                  compositorDevice(compositor.socket, surface, page),
                  surface,
                  size,
                  signal,
                )
              : new Pointer(pageDevice(page), undefined, undefined, signal);
          response.setIncludeSnapshot();
          signal?.throwIfAborted();
          const extra = await act({ tab, page, pointer, size }, params);
          // Without a compositor surface the page's own mouse was used, and its viewport
          // coordinates mean nothing on the video, so only the timing is reported.
          const { start, end, hold } = pointer.record;
          const gesture = {
            tool: name,
            targetId,
            ripple: params.ripple,
            ...(surface ? pointer.record : { start, end, hold }),
          };
          const serialize = response.serialize.bind(response);
          response.serialize = async () => ({
            ...(await serialize()),
            _meta: {
              aperture: { ...(pointer.record.start ? { gesture } : {}), ...extra },
            },
          });
        } catch (error) {
          throw new Error(stripVTControlCharacters(String((error as Error)?.message ?? error)));
        }
      },
    } as ToolDefinition;
  }

  return [
    define(
      "browser_click",
      "Click an element by snapshot ref or selector, or a point by x and y. In a live session the visible pointer glides there and presses real buttons.",
      {
        ...spot(),
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
        doubleClick: z.boolean().optional().describe("Same as clickCount 2"),
        modifiers: z
          .array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"]))
          .optional()
          .describe("Modifier keys to hold during the click"),
        motion,
        ripple,
        arrivalDwellMs,
        holdMs: holdMs.describe("Milliseconds the button stays down for each click"),
      },
      async (run, params) => {
        const point = await locate(run, params, "", "click");
        await run.tab.waitForCompletion(() =>
          run.pointer.click(point, {
            button: params.button ?? "left",
            count: params.clickCount ?? (params.doubleClick ? 2 : 1),
            modifiers: params.modifiers ?? [],
            arrivalDwellMs: params.arrivalDwellMs ?? 0,
            holdMs: params.holdMs ?? 0,
            motion: params.motion ?? "instant",
          }),
        );
      },
    ),
    define(
      "browser_move",
      "Move the pointer over an element or point without clicking, for hover effects.",
      { ...spot(), motion },
      async (run, params) => {
        const point = await locate(run, params);
        await run.tab.waitForCompletion(() => run.pointer.glide(point, params.motion ?? "instant"));
      },
    ),
    define(
      "browser_drag",
      "Drag with the left button from one element or point to another. Works for HTML5 drag and drop and pointer-event drags.",
      {
        ...spot("start"),
        ...spot("end"),
        motion,
        arrivalDwellMs,
        holdMs: holdMs.describe(
          "Milliseconds to hold the button at the destination before releasing",
        ),
      },
      async (run, params) => {
        // Bringing one end into view can scroll the other away: scroll to the end first, then
        // the start, and check that the end is still on screen.
        await locate(run, params, "end");
        const from = await locate(run, params, "start");
        const to = await locate(run, params, "end", "peek").catch(() => {
          throw new Error(
            "The start and end of the drag are not both in view; browser_scroll so both are, then drag.",
          );
        });
        await run.tab.waitForCompletion(() =>
          run.pointer.drag(from, to, {
            arrivalDwellMs: params.arrivalDwellMs ?? 0,
            holdMs: params.holdMs ?? 0,
            motion: params.motion ?? "instant",
          }),
        );
      },
    ),
    define(
      "browser_scroll",
      "Scroll by exact pixel deltas with the mouse wheel over an element or point (the viewport center by default).",
      {
        ...spot(),
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
        await run.tab.waitForCompletion(async () => {
          await run.pointer.glide(point, params.motion ?? "instant");
          // The page's mouse must be there too for the wheel to land.
          await run.page.mouse.move(point.x, point.y);
          await run.pointer.scroll(
            params.deltaX ?? 0,
            params.deltaY ?? 0,
            params.motion ?? "instant",
          );
        });
      },
    ),
    define(
      "browser_cursor_attention",
      "Move the visible cursor in a few smooth loops around an element or viewport point, then settle at its centre.",
      {
        ...spot(),
        radius: z
          .number()
          .min(8)
          .max(240)
          .optional()
          .describe("Loop radius in viewport CSS pixels; defaults to 32"),
        loops: z.number().int().min(1).max(5).optional().describe("Number of loops; defaults to 2"),
        durationMs: z
          .number()
          .min(0)
          .max(10_000)
          .optional()
          .describe(
            "Milliseconds spent looping. Defaults to 0 without a recording; an active recording supplies a visible default.",
          ),
        motion,
      },
      async (run, params) => {
        const point = await locate(run, params);
        await run.tab.waitForCompletion(() =>
          run.pointer.attention(point, {
            radius: params.radius ?? 32,
            loops: params.loops ?? 2,
            durationMs: params.durationMs ?? 0,
            motion: params.motion ?? "instant",
          }),
        );
      },
    ),
    define(
      "browser_focus_viewport",
      "Schedule a camera-only focus interval for one active recording, without moving the cursor.",
      {
        recordingId: z.string().min(1).describe("Active recording that receives this focus effect"),
        ...spot(),
        width: z
          .number()
          .positive()
          .optional()
          .describe("Focus rectangle width in viewport CSS pixels"),
        height: z
          .number()
          .positive()
          .optional()
          .describe("Focus rectangle height in viewport CSS pixels"),
        zoom: z.number().min(1.1).max(4).describe("Zoom factor from 1.1 to 4"),
        durationMs: z
          .number()
          .min(1000)
          .max(10_000)
          .optional()
          .describe("Total focus time, including zoom in and out; defaults to 2200 ms"),
      },
      async (run, params) => {
        const rect = await focusRect(run, params);
        const durationMs = params.durationMs ?? 2200;
        const started = Date.now();
        return {
          focus: {
            recordingId: params.recordingId,
            targetId: await targetIdOf(run.page),
            start: started,
            end: started + durationMs,
            ...rect,
            zoom: params.zoom,
          },
        };
      },
    ),
  ];
}
