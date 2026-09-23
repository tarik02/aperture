import type { BrowserContext, CDPSession, Page } from "playwright-core";

const minute = 60_000;

export interface FrameTree {
  frame: { id: string; url: string };
  childFrames?: FrameTree[];
}

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  openerId?: string;
}

export class RestoreFailure extends Error {}

export async function cdpForPage(
  context: BrowserContext,
  page: Page,
): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await context.newCDPSession(page);
  const info = (await cdp.send("Target.getTargetInfo")) as { targetInfo: TargetInfo };
  if (!info.targetInfo?.targetId) throw new Error("browser omitted the created target ID");

  return { cdp, id: info.targetInfo.targetId };
}

export async function evaluate(
  cdp: CDPSession,
  expression: string,
  contextId?: number,
): Promise<unknown> {
  const result = (await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(contextId === undefined ? {} : { contextId }),
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (result.exceptionDetails || !result.result || !("value" in result.result)) {
    throw new Error("browser could not evaluate the restore runtime");
  }

  return result.result.value;
}

export async function until<T>(
  operation: () => Promise<T | null>,
  description: string,
): Promise<T> {
  const deadline = Date.now() + minute;

  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== null) return result;
    } catch (error) {
      if (error instanceof RestoreFailure) throw error;
      // The frame can change between calls while navigation is in progress.
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`${description} within 1 minute`);
}
