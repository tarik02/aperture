// playwright-core ships its MCP tool implementation as an untyped bundle. This declares
// the parts the host uses; the smoke test fails when a Playwright upgrade breaks them.
declare module "playwright-core/lib/utilsBundle" {
  import type * as zod from "zod";
  export const z: typeof zod;
}

declare module "playwright-core/lib/coreBundle" {
  import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
  import type { ZodObject, ZodRawShape } from "zod";

  export interface ToolResult {
    content: unknown[];
    isError?: boolean;
    _meta?: Record<string, unknown>;
  }

  export interface Response {
    addError(message: string): void;
    setIncludeSnapshot(): void;
    serialize(): Promise<ToolResult>;
  }

  export interface Tab {
    readonly page: Page;
    readonly actionTimeoutOptions: { timeout?: number };
    modalStates(): { type: string }[];
    waitForCompletion(callback: () => Promise<void>): Promise<void>;
    targetLocator(params: { target: string; element?: string }): Promise<{ locator: Locator }>;
  }

  export interface Context {
    currentTab(): Tab | undefined;
    ensureTab(): Promise<Tab>;
  }

  export interface ToolDefinition {
    capability: string;
    schema: {
      name: string;
      title: string;
      description: string;
      inputSchema: ZodObject<ZodRawShape>;
      type: "input" | "readOnly" | "action";
    };
    handle(
      context: Context,
      params: never,
      response: Response,
      signal?: AbortSignal,
    ): Promise<void>;
  }

  export interface Config {
    browser: { contextOptions: object };
  }

  export interface BrowserInfo {
    browser: Browser;
    idleTimer?: unknown;
  }

  export class BrowserBackend {
    constructor(
      config: Config,
      context: BrowserContext,
      tools: ToolDefinition[],
      options: { idleTimer?: unknown; dispose?: () => Promise<void> },
    );
  }

  export interface McpServerFactory {
    name: string;
    nameInConfig: string;
    version: string;
    toolSchemas: ToolDefinition["schema"][];
    create(clientInfo: { cwd: string }): Promise<BrowserBackend>;
  }

  export interface Tools {
    BrowserBackend: typeof BrowserBackend;
    resolveCLIConfigForMCP(options: object): Promise<Config>;
    filteredTools(config: Config): ToolDefinition[];
    createBrowserWithInfo(
      config: Config,
      clientInfo: { cwd: string },
      options: object,
      info: { title: string; workspaceDir: string },
    ): Promise<BrowserInfo>;
    start(factory: McpServerFactory, options: object): Promise<void>;
  }

  const bundle: { tools: Tools };
  export default bundle;
}
