import type { Context, Response, ToolDefinition } from "playwright-core/lib/coreBundle";
import { z } from "playwright-core/lib/utilsBundle";
import { describe, expect, it } from "vite-plus/test";
import { withAction } from "./actions.ts";

const tool = (type: ToolDefinition["schema"]["type"], seen: object[], fail = false) =>
  ({
    capability: "core",
    schema: {
      name: "browser_thing",
      title: "thing",
      description: "",
      inputSchema: z.object({ value: z.string() }),
      type,
    },
    async handle(_context: Context, params: object, response: Response) {
      seen.push(params);
      if (fail) throw new Error("boom");
      void response;
    },
  }) as unknown as ToolDefinition;

const context = { currentTab: () => undefined } as unknown as Context;
const response = () => {
  const errors: string[] = [];
  const response = {
    addError: (message: string) => errors.push(message),
    serialize: async () => ({ content: [], isError: errors.length > 0 }),
  };
  return { response: response as unknown as Response, errors };
};

describe("withAction", () => {
  it("accepts a caption, keeps it from the tool, and reports the action", async () => {
    const seen: object[] = [];
    const wrapped = withAction(tool("input", seen));
    const params = wrapped.schema.inputSchema.parse({ value: "x", caption: "Open it" });
    const { response: fake } = response();

    await wrapped.handle(context, params as never, fake);
    const result = await fake.serialize();

    expect(seen).toEqual([{ value: "x" }]);
    expect(result._meta?.aperture).toMatchObject({
      action: { tool: "browser_thing", caption: "Open it", ok: true },
    });
  });

  it("reports a failing call as not ok", async () => {
    const wrapped = withAction(tool("action", [], true));
    const { response: fake, errors } = response();

    await wrapped.handle(context, { value: "x" } as never, fake);
    const result = await fake.serialize();

    expect(errors).toEqual(["Error: boom"]);
    expect(result._meta?.aperture).toMatchObject({ action: { ok: false } });
  });
});
