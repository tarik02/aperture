import type { BrowserContext, CDPSession, Page } from "playwright-core";

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
