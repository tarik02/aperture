import * as Schema from "effect/Schema";
import type { ElementHandle, Page } from "playwright-core";
import type { Context, ToolDefinition } from "playwright-core/lib/coreBundle";
import { z } from "playwright-core/lib/utilsBundle";
import {
  RecordingEventJson,
  type ActionReveal,
  type ApertureCallContext,
  type RecordingEvent,
} from "@aperture-browser/recording/schema";
import { cadence } from "./cadence.ts";

export interface CallScope {
  context: ApertureCallContext;
  events: { recordingIds: readonly string[]; event: RecordingEvent }[];
  warnings: string[];
  endTargetId?: string;
}
export interface CallState {
  readonly current: CallScope | null;
}

const targetIds = new WeakMap<Page, string>();
const TargetInfo = Schema.Struct({ targetInfo: Schema.Struct({ targetId: Schema.String }) });
export async function targetIdOf(page: Page): Promise<string> {
  const known = targetIds.get(page);
  if (known !== undefined) {
    return known;
  }
  const session = await page.context().newCDPSession(page);
  try {
    const result = Schema.decodeUnknownSync(TargetInfo)(await session.send("Target.getTargetInfo"));
    targetIds.set(page, result.targetInfo.targetId);
    return result.targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

// Reveal each scrollable ancestor directly. Smooth mode uses one rAF animation
// so nested containers move together and do not multiply the visible duration.
type RevealMotion = "instant" | "smooth";

export async function revealElement(
  handle: ElementHandle,
  motion: RevealMotion,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const revealed = await handle.evaluate(async (element, motion) => {
    if (!(element instanceof Element)) {
      throw new Error("target is not an element");
    }
    const ancestors: Element[] = [];
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const scrollsVertically =
        parent.scrollHeight > parent.clientHeight &&
        style.overflowY !== "visible" &&
        style.overflowY !== "clip";
      const scrollsHorizontally =
        parent.scrollWidth > parent.clientWidth &&
        style.overflowX !== "visible" &&
        style.overflowX !== "clip";
      if (scrollsVertically || scrollsHorizontally) {
        ancestors.push(parent);
      }
    }
    const initialBox = element.getBoundingClientRect();
    const box = {
      top: initialBox.top,
      left: initialBox.left,
      right: initialBox.right,
      bottom: initialBox.bottom,
    };
    const plans: {
      parent: Element;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      duration: number;
    }[] = [];
    for (const parent of ancestors) {
      const bounds =
        parent === document.scrollingElement
          ? {
              top: 0,
              left: 0,
              right: innerWidth,
              bottom: innerHeight,
              width: innerWidth,
              height: innerHeight,
            }
          : parent.getBoundingClientRect();
      const dx =
        box.left < bounds.left || box.right > bounds.right
          ? (box.left + box.right - bounds.left - bounds.right) / 2
          : 0;
      const dy =
        box.top < bounds.top || box.bottom > bounds.bottom
          ? (box.top + box.bottom - bounds.top - bounds.bottom) / 2
          : 0;
      const fromX = parent.scrollLeft,
        fromY = parent.scrollTop;
      const toX = Math.max(0, Math.min(parent.scrollWidth - parent.clientWidth, fromX + dx));
      const toY = Math.max(0, Math.min(parent.scrollHeight - parent.clientHeight, fromY + dy));
      const distance = Math.hypot(toX - fromX, toY - fromY);
      if (distance < 1) {
        continue;
      }
      plans.push({
        parent,
        fromX,
        fromY,
        toX,
        toY,
        duration: Math.min(500, Math.max(120, (distance / 900) * 1000)),
      });
      const movedX = toX - fromX;
      const movedY = toY - fromY;
      box.left -= movedX;
      box.right -= movedX;
      box.top -= movedY;
      box.bottom -= movedY;
    }
    if (plans.length === 0) {
      return false;
    }
    if (motion === "instant") {
      for (const plan of plans) {
        plan.parent.scrollTo(plan.toX, plan.toY);
      }
      return true;
    }
    const previousBehaviors = plans.map(({ parent }) => ({
      parent,
      behavior: parent instanceof HTMLElement ? parent.style.scrollBehavior : "",
    }));
    for (const { parent } of previousBehaviors) {
      if (parent instanceof HTMLElement) {
        parent.style.scrollBehavior = "auto";
      }
    }
    const began = performance.now();
    try {
      await new Promise<void>((resolve) => {
        const frame = () => {
          const elapsed = performance.now() - began;
          let complete = true;
          for (const plan of plans) {
            const t = Math.min(1, elapsed / plan.duration);
            const eased = t * t * (3 - 2 * t);
            plan.parent.scrollTo(
              plan.fromX + (plan.toX - plan.fromX) * eased,
              plan.fromY + (plan.toY - plan.fromY) * eased,
            );
            complete &&= t === 1;
          }
          if (complete) {
            resolve();
          } else {
            requestAnimationFrame(frame);
          }
        };
        requestAnimationFrame(frame);
      });
    } finally {
      for (const { parent, behavior } of previousBehaviors) {
        if (parent instanceof HTMLElement) {
          parent.style.scrollBehavior = behavior;
        }
      }
    }
    return true;
  }, motion);
  signal?.throwIfAborted();
  return revealed;
}

export async function revealTarget(
  context: Context,
  target: string,
  element: string | undefined,
  motion: RevealMotion,
  signal?: AbortSignal,
): Promise<ActionReveal | undefined> {
  const tab = await context.ensureTab();
  const { locator } = await tab.targetLocator({
    target,
    ...(element === undefined ? {} : { element }),
  });
  const handle = await locator.elementHandle();
  if (handle === null) {
    throw new Error("target element disappeared");
  }
  const chain: ElementHandle[] = [handle];
  let frame = await handle.ownerFrame();
  while (frame !== null && frame.parentFrame() !== null) {
    chain.push(await frame.frameElement());
    frame = frame.parentFrame();
  }
  try {
    const reveals = await Promise.all(
      chain.map(async (item) => {
        const startedAt = Date.now();
        if (await revealElement(item, motion, signal)) {
          return { start: startedAt, end: Date.now() };
        }
        return undefined;
      }),
    );
    const visible = reveals.filter((reveal) => reveal !== undefined);
    if (visible.length === 0) {
      return undefined;
    }
    return {
      start: Math.min(...visible.map((reveal) => reveal.start)),
      end: Math.max(...visible.map((reveal) => reveal.end)),
    };
  } finally {
    await Promise.all(chain.map((item) => item.dispose()));
  }
}

// Already parsed by Playwright's Zod adapter; the fields shared with action policy.
const ActionArguments = z.object({
  caption: z.string().optional(),
  smoothScroll: z.boolean().optional(),
  recordingId: z.string().min(1).optional(),
  target: z.string().optional(),
  element: z.string().optional(),
  startTarget: z.string().optional(),
  startElement: z.string().optional(),
  endTarget: z.string().optional(),
  endElement: z.string().optional(),
  fields: z
    .array(z.object({ target: z.string().optional(), name: z.string().optional() }))
    .optional(),
});

export function withAction(tool: ToolDefinition, state: CallState): ToolDefinition {
  if (tool.schema.type === "readOnly") {
    return tool;
  }
  return {
    ...tool,
    schema: {
      ...tool.schema,
      inputSchema: tool.schema.inputSchema.extend({
        caption: z.string().max(500).optional().describe("Short on-screen recording caption"),
        smoothScroll: z
          .boolean()
          .optional()
          .describe("Smoothly reveal action targets; defaults on for watchable automation"),
      }),
    },
    async handle(context, params, response, signal) {
      const scope = state.current;
      if (scope === null) {
        throw new Error("browser call context is unavailable");
      }
      const parsed = ActionArguments.parse(params);
      const { caption: _caption, smoothScroll: _smoothScroll, ...argumentsForTool } = params;
      const before = context.currentTab();
      let startTargetId = "";
      if (before !== undefined) {
        try {
          startTargetId = await targetIdOf(before.page);
        } catch {
          scope.warnings.push("starting browser target could not be observed");
        }
      }
      const start = Date.now();
      let reveal: ActionReveal | undefined;
      let ok = true;
      try {
        if (tool.schema.name !== "browser_focus_viewport") {
          const motion =
            (parsed.smoothScroll ?? cadence[scope.context.cadence].smoothScroll) === true
              ? "smooth"
              : "instant";
          const targets = [
            { target: parsed.target, element: parsed.element },
            { target: parsed.endTarget, element: parsed.endElement },
            { target: parsed.startTarget, element: parsed.startElement },
            ...(parsed.fields ?? []).map((field) => ({
              target: field.target,
              element: field.name,
            })),
          ];
          for (const item of targets) {
            if (item.target !== undefined) {
              const targetReveal = await revealTarget(
                context,
                item.target,
                item.element,
                motion,
                signal,
              );
              if (targetReveal !== undefined) {
                reveal =
                  reveal === undefined
                    ? targetReveal
                    : {
                        start: Math.min(reveal.start, targetReveal.start),
                        end: Math.max(reveal.end, targetReveal.end),
                      };
              }
            }
          }
        }
        await tool.handle(context, argumentsForTool, response, signal);
      } catch (error) {
        ok = false;
        response.addError(String(error));
      } finally {
        let targetId = startTargetId;
        const after = context.currentTab();
        if (after !== undefined) {
          try {
            targetId = await targetIdOf(after.page);
          } catch {
            scope.warnings.push("ending browser target could not be observed");
          }
        }
        if (targetId !== "") {
          scope.endTargetId = targetId;
        }
        const recordingIds =
          parsed.recordingId === undefined
            ? scope.context.recordingIds
            : scope.context.recordingIds.includes(parsed.recordingId)
              ? [parsed.recordingId]
              : [];
        scope.events.push({
          recordingIds,
          event: {
            _tag: "Action",
            tool: tool.schema.name,
            startTargetId,
            targetId,
            start,
            end: Date.now(),
            ok,
            ...(reveal === undefined ? {} : { reveal }),
            ...(parsed.caption === undefined ? {} : { caption: parsed.caption }),
          },
        });
      }
    },
  };
}

export function encodeJournal(scope: CallScope, failed: boolean) {
  const journal: { recordingId: string; line: string }[] = [];
  for (const entry of scope.events) {
    try {
      const event =
        entry.event._tag === "Action" && failed ? { ...entry.event, ok: false } : entry.event;
      const line = Schema.encodeSync(RecordingEventJson)(event);
      for (const recordingId of entry.recordingIds) {
        journal.push({ recordingId, line });
      }
    } catch {
      scope.warnings.push("recording event could not be encoded");
    }
  }
  return journal;
}
