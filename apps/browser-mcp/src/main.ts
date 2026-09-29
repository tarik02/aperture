import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import coreBundle from "playwright-core/lib/coreBundle";
import { pointerTools } from "./pointer-tools.ts";

const { tools: playwright } = coreBundle;

// Playwright's own click, hover, drag and raw mouse tools; the pointer tools replace them.
const replaced = /^browser_(click|hover|drag|mouse_.*)$/;

const { values } = parseArgs({
  options: {
    "cdp-endpoint": { type: "string" },
    "output-dir": { type: "string" },
    caps: { type: "string" },
    "compositor-socket": { type: "string" },
    "targets-url": { type: "string" },
    version: { type: "boolean" },
  },
});

if (values.version) {
  const require = createRequire(import.meta.url);
  console.log(`Version ${require("playwright-core/package.json").version}`);
} else {
  const options = {
    cdpEndpoint: values["cdp-endpoint"],
    cdpTimeout: 30_000,
    codegen: "none",
    filePaths: "relative",
    idleTimeout: 0,
    webmcp: false,
    caps: values.caps?.split(","),
    outputDir: values["output-dir"],
  };
  const config = await playwright.resolveCLIConfigForMCP(options);
  const compositor =
    values["compositor-socket"] && values["targets-url"]
      ? { socket: values["compositor-socket"], targetsUrl: values["targets-url"] }
      : undefined;
  const tools = [
    ...playwright.filteredTools(config).filter((tool) => !replaced.test(tool.schema.name)),
    ...pointerTools(compositor),
  ];

  await playwright.start(
    {
      name: "aperture-browser",
      nameInConfig: "aperture",
      version: "0.0.0",
      toolSchemas: tools.map((tool) => tool.schema),
      async create(clientInfo) {
        const info = await playwright.createBrowserWithInfo(config, clientInfo, options, {
          title: "aperture",
          workspaceDir: clientInfo.cwd,
        });
        const context =
          info.browser.contexts()[0] ??
          (await info.browser.newContext(config.browser.contextOptions));
        // Closing a browser attached over CDP only disconnects.
        return new playwright.BrowserBackend(config, context, tools, {
          idleTimer: info.idleTimer,
          dispose: () => info.browser.close().catch(() => {}),
        });
      },
    },
    {},
  );
}
