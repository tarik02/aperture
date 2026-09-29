import type { Page } from "playwright-core";
import type { Context, ToolDefinition } from "playwright-core/lib/coreBundle";
import { z } from "playwright-core/lib/utilsBundle";

const targetIds = new WeakMap<Page, string>();

/** The CDP target id of a page, which names the browser target Aperture records. */
export async function targetIdOf(page: Page): Promise<string> {
  const known = targetIds.get(page);
  if (known) return known;
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = (await session.send("Target.getTargetInfo")) as {
      targetInfo: { targetId: string };
    };
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
  });
  return {
    ...tool,
    schema: { ...tool.schema, inputSchema },
    async handle(context, params, response, signal) {
      const { caption, ...rest } = params as { caption?: string };
      let targetId = await tabTargetId(context);
      const start = Date.now();
      let ok = true;
      try {
        await tool.handle(context, rest as never, response, signal);
      } catch (error) {
        // Reported through the result, which a rethrown error would replace; the text
        // is what Playwright formats for a thrown error.
        ok = false;
        response.addError(String(error));
      }
      const end = Date.now();
      targetId ||= await tabTargetId(context);
      const serialize = response.serialize.bind(response);
      response.serialize = async () => {
        const result = await serialize();
        const action = {
          tool: tool.schema.name,
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
