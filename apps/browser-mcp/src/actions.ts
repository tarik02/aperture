import * as Schema from "effect/Schema";
import type { ElementHandle, Page } from "playwright-core";
import type { Context, ToolDefinition } from "playwright-core/lib/coreBundle";
import { z } from "playwright-core/lib/utilsBundle";
import {
  RecordingEventJson,
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
  current: CallScope | null;
}

const targetIds = new WeakMap<Page, string>();
const TargetInfo = Schema.Struct({ targetInfo: Schema.Struct({ targetId: Schema.String }) });
export async function targetIdOf(page: Page): Promise<string> {
  const known = targetIds.get(page);
  if (known !== undefined) return known;
  const session = await page.context().newCDPSession(page);
  try {
    const result = Schema.decodeUnknownSync(TargetInfo)(await session.send("Target.getTargetInfo"));
    targetIds.set(page, result.targetInfo.targetId);
    return result.targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

// Animate each scrollable ancestor directly. Waiting on its own rAF animation
// avoids browser-dependent scrollend support and nested-frame completion guesses.
export async function smoothElementIntoView(handle: ElementHandle, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await handle.evaluate(async (element) => {
    if (!(element instanceof Element)) throw new Error("target is not an element");
    const ancestors: Element[] = [];
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth)
        ancestors.push(parent);
    }
    for (const parent of ancestors.reverse()) {
      const box = element.getBoundingClientRect();
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
      if (distance < 1) continue;
      const duration = Math.min(600, Math.max(120, (distance / 1200) * 1000));
      const began = performance.now();
      const previousBehavior = parent instanceof HTMLElement ? parent.style.scrollBehavior : "";
      if (parent instanceof HTMLElement) parent.style.scrollBehavior = "auto";
      try {
        await new Promise<void>((resolve) => {
          const frame = () => {
            const t = Math.min(1, (performance.now() - began) / duration);
            const eased = t * t * (3 - 2 * t);
            parent.scrollTo(fromX + (toX - fromX) * eased, fromY + (toY - fromY) * eased);
            if (t === 1) resolve();
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
      } finally {
        if (parent instanceof HTMLElement) parent.style.scrollBehavior = previousBehavior;
      }
    }
  });
  signal?.throwIfAborted();
}

export async function revealTarget(
  context: Context,
  target: string,
  element: string | undefined,
  signal?: AbortSignal,
) {
  const tab = await context.ensureTab();
  const { locator } = await tab.targetLocator({
    target,
    ...(element === undefined ? {} : { element }),
  });
  const handle = await locator.elementHandle();
  if (handle === null) throw new Error("target element disappeared");
  const chain: ElementHandle[] = [handle];
  let frame = await handle.ownerFrame();
  while (frame !== null && frame.parentFrame() !== null) {
    chain.push(await frame.frameElement());
    frame = frame.parentFrame();
  }
  try {
    for (const item of chain.reverse()) await smoothElementIntoView(item, signal);
  } finally {
    await Promise.all(chain.map((item) => item.dispose()));
  }
}

// Already parsed by Playwright's Zod adapter; the fields shared with action policy.
const ActionArguments = z.object({
  caption: z.string().optional(),
  smoothScroll: z.boolean().optional(),
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
  if (tool.schema.type === "readOnly") return tool;
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
      if (scope === null) throw new Error("browser call context is unavailable");
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
      let ok = true;
      try {
        if (
          (parsed.smoothScroll ?? cadence[scope.context.cadence].smoothScroll) &&
          tool.schema.name !== "browser_focus_viewport"
        ) {
          const targets = [
            { target: parsed.target, element: parsed.element },
            { target: parsed.endTarget, element: parsed.endElement },
            { target: parsed.startTarget, element: parsed.startElement },
            ...(parsed.fields ?? []).map((field) => ({
              target: field.target,
              element: field.name,
            })),
          ];
          for (const item of targets)
            if (item.target !== undefined)
              await revealTarget(context, item.target, item.element, signal);
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
        if (targetId !== "") scope.endTargetId = targetId;
        scope.events.push({
          recordingIds: scope.context.recordingIds,
          event: {
            _tag: "Action",
            tool: tool.schema.name,
            startTargetId,
            targetId,
            start,
            end: Date.now(),
            ok,
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
      for (const recordingId of entry.recordingIds) journal.push({ recordingId, line });
    } catch {
      scope.warnings.push("recording event could not be encoded");
    }
  }
  return journal;
}
