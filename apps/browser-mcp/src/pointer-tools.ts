import type { Page } from "playwright-core";
import type { Tab, ToolDefinition } from "playwright-core/lib/coreBundle";
import { z } from "playwright-core/lib/utilsBundle";
import type { infer as Infer, ZodRawShape } from "zod";
import { cadence } from "./cadence.ts";
import { targetIdOf, type CallState } from "./actions.ts";
import { surfaceOf, type CompositorConfig } from "./compositor.ts";
import { compositorDevice, pageDevice, Pointer } from "./pointer.ts";
import type { Point } from "./motion.ts";

const spot = {
  target: z.string().optional(),
  element: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
};
const motion = z
  .union([
    z.enum(["natural", "fast", "instant"]),
    z.object({ durationMs: z.number().min(0).max(10_000) }),
  ])
  .optional();
const dwell = z.number().min(0).max(10_000).optional();
const hold = z.number().min(0).max(10_000).optional();
const PointerArguments = z.object({
  ...spot,
  startTarget: z.string().optional(),
  startElement: z.string().optional(),
  startX: z.number().optional(),
  startY: z.number().optional(),
  endTarget: z.string().optional(),
  endElement: z.string().optional(),
  endX: z.number().optional(),
  endY: z.number().optional(),
  motion,
  arrivalDwellMs: dwell,
  holdMs: hold,
  button: z.enum(["left", "right", "middle"]).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  doubleClick: z.boolean().optional(),
  modifiers: z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional(),
  ripple: z.boolean().optional(),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  radius: z.number().min(8).max(240).optional(),
  loops: z.number().int().min(1).max(5).optional(),
  durationMs: z.number().min(0).max(10_000).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  zoom: z.number().min(1.1).max(4).optional(),
  recordingId: z.string().min(1).optional(),
});
type Params = Infer<typeof PointerArguments>;
interface Spot {
  target?: string;
  element?: string;
  x?: number;
  y?: number;
}
interface Run {
  tab: Tab;
  page: Page;
  pointer: Pointer;
  size: { width: number; height: number };
  targetId: string;
  signal?: AbortSignal;
}

async function locate(
  run: Run,
  params: Spot,
  mode: "click" | "hover" | "peek" = "hover",
): Promise<Point> {
  if (params.target !== undefined) {
    const { locator } = await run.tab.targetLocator({
      target: params.target,
      ...(params.element === undefined ? {} : { element: params.element }),
    });
    if (mode !== "peek") await locator[mode]({ trial: true, ...run.tab.actionTimeoutOptions });
    const box = await locator.boundingBox();
    if (box === null) throw new Error("target is not visible");
    const left = Math.max(0, box.x),
      top = Math.max(0, box.y);
    const right = Math.min(run.size.width, box.x + box.width),
      bottom = Math.min(run.size.height, box.y + box.height);
    if (right <= left || bottom <= top) throw new Error("target is outside the viewport");
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }
  if (params.x === undefined || params.y === undefined)
    throw new Error("give a target or both x and y");
  if (params.x < 0 || params.y < 0 || params.x >= run.size.width || params.y >= run.size.height)
    throw new Error("point is outside the viewport");
  return { x: params.x, y: params.y };
}

export function pointerTools(state: CallState, compositor?: CompositorConfig): ToolDefinition[] {
  function define(
    name: string,
    description: string,
    shape: ZodRawShape,
    act: (run: Run, params: Params) => Promise<void>,
  ): ToolDefinition {
    return {
      capability: "core",
      schema: { name, title: name, description, inputSchema: z.object(shape), type: "input" },
      async handle(context, argumentsForTool, response, signal) {
        const scope = state.current;
        if (scope === null) throw new Error("browser call context is unavailable");
        const params = PointerArguments.parse(argumentsForTool);
        const tab = await context.ensureTab();
        if (tab.modalStates().length > 0)
          throw new Error("handle the open dialog before using pointer tools");
        const page = tab.page;
        const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const targetId = await targetIdOf(page);
        const surface =
          compositor === undefined ? undefined : await surfaceOf(compositor, targetId, signal);
        const device =
          surface !== undefined && compositor !== undefined
            ? compositorDevice(compositor.socket, surface, page)
            : pageDevice(page);
        const pointer = new Pointer(device, surface, size, signal);
        response.setIncludeSnapshot();
        try {
          await act({ tab, page, pointer, size, targetId, signal }, params);
        } finally {
          if (pointer.record.start !== 0)
            scope.events.push({
              recordingIds:
                params.recordingId === undefined
                  ? scope.context.recordingIds
                  : [params.recordingId],
              event: {
                _tag: "Gesture",
                tool: name,
                targetId,
                space: surface === undefined ? "viewport" : "compositor",
                ...pointer.record,
                end: pointer.record.end || Date.now(),
                ...(params.ripple === undefined ? {} : { ripple: params.ripple }),
              },
            });
        }
      },
    };
  }
  const defaults = () => {
    if (state.current === null) throw new Error("browser call context is unavailable");
    return cadence[state.current.context.cadence];
  };
  return [
    define(
      "browser_click",
      "Click an element or viewport point with the visible pointer.",
      {
        ...spot,
        button: PointerArguments.shape.button,
        clickCount: PointerArguments.shape.clickCount,
        doubleClick: PointerArguments.shape.doubleClick,
        modifiers: PointerArguments.shape.modifiers,
        motion,
        arrivalDwellMs: dwell,
        holdMs: hold,
        ripple: PointerArguments.shape.ripple,
      },
      async (run, params) => {
        const point = await locate(run, params, "click");
        const policy = defaults();
        await run.tab.waitForCompletion(() =>
          run.pointer.click(point, {
            button: params.button ?? "left",
            count: params.clickCount ?? (params.doubleClick === true ? 2 : 1),
            modifiers: params.modifiers ?? [],
            arrivalDwellMs: params.arrivalDwellMs ?? policy.dwellMs,
            holdMs: params.holdMs ?? policy.holdMs,
            motion: params.motion ?? policy.motion,
          }),
        );
      },
    ),
    define(
      "browser_move",
      "Move the pointer over an element or viewport point.",
      { ...spot, motion },
      async (run, params) => {
        const point = await locate(run, params);
        await run.tab.waitForCompletion(() =>
          run.pointer.glide(point, params.motion ?? defaults().motion),
        );
      },
    ),
    define(
      "browser_drag",
      "Drag between two elements or viewport points.",
      {
        startTarget: PointerArguments.shape.startTarget,
        startElement: PointerArguments.shape.startElement,
        startX: PointerArguments.shape.startX,
        startY: PointerArguments.shape.startY,
        endTarget: PointerArguments.shape.endTarget,
        endElement: PointerArguments.shape.endElement,
        endX: PointerArguments.shape.endX,
        endY: PointerArguments.shape.endY,
        motion,
        arrivalDwellMs: dwell,
        holdMs: hold,
      },
      async (run, params) => {
        const from = await locate(run, {
          target: params.startTarget,
          element: params.startElement,
          x: params.startX,
          y: params.startY,
        });
        const to = await locate(
          run,
          { target: params.endTarget, element: params.endElement, x: params.endX, y: params.endY },
          "peek",
        );
        const policy = defaults();
        await run.tab.waitForCompletion(() =>
          run.pointer.drag(from, to, {
            motion: params.motion ?? policy.motion,
            arrivalDwellMs: params.arrivalDwellMs ?? policy.dwellMs,
            holdMs: params.holdMs ?? policy.holdMs,
          }),
        );
      },
    ),
    define(
      "browser_scroll",
      "Smooth wheel scrolling over an element or point, or the viewport center.",
      {
        ...spot,
        motion,
        deltaX: PointerArguments.shape.deltaX,
        deltaY: PointerArguments.shape.deltaY,
      },
      async (run, params) => {
        const point =
          params.target !== undefined || params.x !== undefined || params.y !== undefined
            ? await locate(run, params)
            : { x: run.size.width / 2, y: run.size.height / 2 };
        const movement = params.motion ?? defaults().motion;
        await run.tab.waitForCompletion(async () => {
          await run.pointer.glide(point, movement);
          await run.page.mouse.move(point.x, point.y);
          await run.pointer.scroll(params.deltaX ?? 0, params.deltaY ?? 0, movement);
        });
      },
    ),
    define(
      "browser_cursor_attention",
      "Draw attention with cursor loops for one active recording, independently of camera focus.",
      {
        ...spot,
        recordingId: z.string().min(1),
        motion,
        radius: PointerArguments.shape.radius,
        loops: PointerArguments.shape.loops,
        durationMs: PointerArguments.shape.durationMs,
      },
      async (run, params) => {
        const scope = state.current;
        if (
          scope === null ||
          params.recordingId === undefined ||
          !scope.context.recordingIds.includes(params.recordingId)
        )
          throw new Error("cursor attention requires an active recordingId");
        const point = await locate(run, params);
        const start = Date.now();
        await run.tab.waitForCompletion(() =>
          run.pointer.attention(point, {
            radius: params.radius ?? 32,
            loops: params.loops ?? 2,
            durationMs: params.durationMs ?? defaults().attentionMs,
            motion: params.motion ?? defaults().motion,
          }),
        );
        scope.events.push({
          recordingIds: [params.recordingId],
          event: {
            _tag: "Attention",
            targetId: run.targetId,
            start,
            end: Date.now(),
            ...point,
            radius: params.radius ?? 32,
          },
        });
      },
    ),
    define(
      "browser_focus_viewport",
      "Focus the camera for one active recording while following tools continue; never moves the cursor.",
      {
        ...spot,
        recordingId: z.string().min(1),
        width: PointerArguments.shape.width,
        height: PointerArguments.shape.height,
        zoom: z.number().min(1.1).max(4),
        durationMs: z.number().min(100).max(10_000).optional(),
      },
      async (run, params) => {
        const scope = state.current;
        if (
          scope === null ||
          params.recordingId === undefined ||
          !scope.context.recordingIds.includes(params.recordingId)
        )
          throw new Error("focus requires an active recordingId");
        let rect;
        if (params.target !== undefined) {
          const { locator } = await run.tab.targetLocator({
            target: params.target,
            ...(params.element === undefined ? {} : { element: params.element }),
          });
          rect = await locator.boundingBox();
          if (rect === null) throw new Error("focus target is not visible");
        } else {
          if (
            params.x === undefined ||
            params.y === undefined ||
            params.width === undefined ||
            params.height === undefined
          )
            throw new Error("give a target or x, y, width and height");
          rect = { x: params.x, y: params.y, width: params.width, height: params.height };
        }
        if (
          rect.x < 0 ||
          rect.y < 0 ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.x + rect.width > run.size.width ||
          rect.y + rect.height > run.size.height
        )
          throw new Error("focus rectangle must be inside the viewport");
        if (params.zoom === undefined) throw new Error("zoom is required");
        const start = Date.now();
        scope.events.push({
          recordingIds: [params.recordingId],
          event: {
            _tag: "Focus",
            targetId: run.targetId,
            start,
            end: start + (params.durationMs ?? 2200),
            ...rect,
            zoom: params.zoom,
          },
        });
      },
    ),
  ];
}
