import type { ElementHandle, Page } from "playwright-core";
import type { Context, ToolDefinition } from "playwright-core/lib/coreBundle";
import { z } from "playwright-core/lib/utilsBundle";

const targetIds = new WeakMap<Page, string>();
const targetInfoResult = z.object({ targetInfo: z.object({ targetId: z.string() }) });

/** The CDP target id of a page, which names the browser target Aperture records. */
export async function targetIdOf(page: Page): Promise<string> {
  const known = targetIds.get(page);
  if (known) return known;
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = targetInfoResult.parse(await session.send("Target.getTargetInfo"));
    targetIds.set(page, targetInfo.targetId);
    return targetInfo.targetId;
  } finally {
    await session.detach().catch(() => {});
  }
}

const tabTargetId = async (context: Context) => {
  const tab = context.currentTab();
  return tab ? targetIdOf(tab.page).catch(() => "") : "";
};

async function smoothElementIntoView(element: ElementHandle, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const scrolling = element.evaluate(async (element) => {
    if (!(element instanceof Element)) return;
    const rect = element.getBoundingClientRect();
    const visible =
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.right <= window.innerWidth;
    if (visible) return;
    element.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    await new Promise<void>((resolve) => {
      let previousX = window.scrollX;
      let previousY = window.scrollY;
      let previousTop = rect.top;
      let previousLeft = rect.left;
      let stableFrames = 0;
      const deadline = performance.now() + 2000;
      const sample = () => {
        const current = element.getBoundingClientRect();
        const stable =
          Math.abs(window.scrollX - previousX) < 0.5 &&
          Math.abs(window.scrollY - previousY) < 0.5 &&
          Math.abs(current.top - previousTop) < 0.5 &&
          Math.abs(current.left - previousLeft) < 0.5 &&
          current.bottom > 0 &&
          current.right > 0 &&
          current.top < window.innerHeight &&
          current.left < window.innerWidth;
        stableFrames = stable ? stableFrames + 1 : 0;
        previousX = window.scrollX;
        previousY = window.scrollY;
        previousTop = current.top;
        previousLeft = current.left;
        if (stableFrames >= 3 || performance.now() >= deadline) resolve();
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
  if (!signal) {
    await scrolling;
    return;
  }
  let rejectCancelled: (reason?: unknown) => void = () => {};
  let aborted = false;
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    void element
      .evaluate((element) => {
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const behavior = ancestor.style.scrollBehavior;
          ancestor.style.scrollBehavior = "auto";
          ancestor.scrollTo(ancestor.scrollLeft, ancestor.scrollTop);
          ancestor.style.scrollBehavior = behavior;
        }
        const behavior = document.documentElement.style.scrollBehavior;
        document.documentElement.style.scrollBehavior = "auto";
        window.scrollTo(window.scrollX, window.scrollY);
        document.documentElement.style.scrollBehavior = behavior;
      })
      .catch(() => {});
    rejectCancelled(signal.reason);
  };
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([scrolling, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function smoothTargetIntoView(
  context: Context,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const targets: { target: string; element?: string }[] = [];
  const add = (target: unknown, element: unknown) => {
    if (typeof target === "string") {
      targets.push({ target, ...(typeof element === "string" ? { element } : {}) });
    }
  };
  add(params.target, params.element);
  add(params.startTarget, params.startElement);
  add(params.endTarget, params.endElement);
  if (Array.isArray(params.fields)) {
    for (const field of params.fields) {
      if (field && typeof field === "object") {
        const value = field as Record<string, unknown>;
        add(value.target, value.element ?? value.name);
      }
    }
  }
  if (!targets.length) return;

  const tab = await context.ensureTab();
  for (const target of targets) {
    const { locator } = await tab.targetLocator(target);
    const element = await locator.elementHandle();
    if (!element) continue;
    const scrollChain: ElementHandle[] = [element];
    let frame = await element.ownerFrame();
    while (frame?.parentFrame()) {
      scrollChain.push(await frame.frameElement());
      frame = frame.parentFrame();
    }
    for (const scrollTarget of scrollChain.reverse()) {
      await smoothElementIntoView(scrollTarget, signal);
    }
  }
}

/**
 * Makes a tool that changes something accept a `caption` and report the call as
 * `_meta.aperture.action`, which the recording's timeline is built from. Read-only
 * tools are returned unchanged. The caption never reaches the tool.
 */
export function withAction(tool: ToolDefinition): ToolDefinition {
  if (tool.schema.type === "readOnly") return tool;
  const inputSchema = tool.schema.inputSchema.extend({
    caption: z
      .string()
      .max(500)
      .optional()
      .describe("Short on-screen caption for this step when the session is recorded"),
    smoothScroll: z
      .boolean()
      .optional()
      .describe(
        "Smoothly bring target elements into view before acting. Active recordings enable this by default.",
      ),
  });
  return {
    ...tool,
    schema: { ...tool.schema, inputSchema },
    async handle(context, params, response, signal) {
      const { caption, smoothScroll, ...rest } = params as {
        caption?: string;
        smoothScroll?: boolean;
      };
      const before = await tabTargetId(context);
      const start = Date.now();
      let ok = true;
      try {
        if (smoothScroll) await smoothTargetIntoView(context, rest, signal);
        await tool.handle(context, rest as never, response, signal);
      } catch (error) {
        // Reported through the result, which a rethrown error would replace; the text
        // is what Playwright formats for a thrown error.
        ok = false;
        response.addError(String(error));
      }
      const end = Date.now();
      // The tab the call ended on, which a recording that follows the automation moves to.
      const targetId = (await tabTargetId(context)) || before;
      const serialize = response.serialize.bind(response);
      response.serialize = async () => {
        let result: Awaited<ReturnType<typeof serialize>>;
        try {
          result = await serialize();
        } catch (error) {
          // Playwright answers a failure here with an error result that has no `_meta`
          // (a tab that closed while its snapshot was taken does it), which would lose
          // the report of a call that did run.
          ok = false;
          result = {
            content: [{ type: "text", text: `### Error\n${String(error)}` }],
            isError: true,
          };
        }
        const action = {
          tool: tool.schema.name,
          startTargetId: before,
          targetId,
          start,
          end,
          caption,
          ok: ok && !result.isError,
        };
        return {
          ...result,
          _meta: { ...result._meta, aperture: { ...(result._meta?.aperture as object), action } },
        };
      };
    },
  };
}
