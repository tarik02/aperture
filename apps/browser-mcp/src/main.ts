import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { AsyncLocalStorage } from "node:async_hooks";
import coreBundle from "playwright-core/lib/coreBundle";
import { ApertureCallContext, ApertureCallResult } from "@aperture-browser/recording/schema";
import { encodeJournal, withAction, type CallScope, type CallState } from "./actions.ts";
import { pointerTools } from "./pointer-tools.ts";
import { releaseAll } from "./pointer.ts";

const { tools: playwright } = coreBundle;
const Envelope = Schema.Struct({
  _meta: Schema.optionalKey(Schema.Struct({ aperture: Schema.optionalKey(ApertureCallContext) })),
});
const host = Command.make(
  "aperture-browser-mcp",
  {
    cdpEndpoint: Flag.String("cdp-endpoint"),
    outputDir: Flag.String("output-dir").pipe(Flag.withDefault(".")),
    caps: Flag.String("caps").pipe(Flag.withDefault("")),
    compositorSocket: Flag.String("compositor-socket").pipe(Flag.withDefault("")),
    targetsUrl: Flag.String("targets-url").pipe(Flag.withDefault("")),
  },
  (values) =>
    Effect.tryPromise({
      try: async () => {
        const options = {
          cdpEndpoint: values.cdpEndpoint,
          cdpTimeout: 30_000,
          codegen: "none",
          filePaths: "relative",
          idleTimeout: 0,
          webmcp: false,
          caps: values.caps === "" ? [] : values.caps.split(","),
          outputDir: values.outputDir,
        };
        const config = await playwright.resolveCLIConfigForMCP(options);
        const compositor =
          values.compositorSocket === ""
            ? undefined
            : { socket: values.compositorSocket, targetsUrl: values.targetsUrl };
        const createTools = (state: CallState) =>
          [
            ...playwright
              .filteredTools(config)
              .filter((tool) => !/^browser_(click|hover|drag|mouse_.*)$/.test(tool.schema.name)),
            ...pointerTools(state, compositor),
          ].map((tool) => withAction(tool, state));
        const schemas = createTools({ current: null }).map((tool) => tool.schema);
        await playwright.start(
          {
            name: "aperture-browser",
            nameInConfig: "aperture",
            version: "0.0.0",
            toolSchemas: schemas,
            async create(clientInfo) {
              const info = await playwright.createBrowserWithInfo(config, clientInfo, options, {
                title: "aperture",
                workspaceDir: clientInfo.cwd,
              });
              const context =
                info.browser.contexts()[0] ??
                (await info.browser.newContext(config.browser.contextOptions));
              const scopes = new AsyncLocalStorage<CallScope | null>();
              const state: CallState = {
                get current() {
                  return scopes.getStore() ?? null;
                },
              };
              const activeCalls = new Map<symbol, string>();
              const backend = new playwright.BrowserBackend(config, context, createTools(state), {
                idleTimer: info.idleTimer,
                dispose: async () => {
                  await releaseAll();
                  await info.browser.close();
                },
              });
              const callTool = backend.callTool.bind(backend);
              backend.callTool = async (name, argumentsForTool = {}, signal) => {
                const focus = "browser_focus_viewport";
                const canOverlap =
                  name === focus || [...activeCalls.values()].every((active) => active === focus);
                if (activeCalls.size > 0 && !canOverlap) {
                  throw new Error("concurrent browser calls are not supported");
                }
                const envelope = Schema.decodeUnknownSync(Envelope)(argumentsForTool);
                const scope: CallScope = {
                  context: envelope._meta?.aperture ?? {
                    cadence: "immediate" as const,
                    recordingIds: [],
                  },
                  events: [],
                  warnings: [],
                };
                const call = Symbol(name);
                activeCalls.set(call, name);
                try {
                  return await scopes.run(scope, async () => {
                    const result = await callTool(name, argumentsForTool, signal);
                    const metadata = Schema.encodeSync(ApertureCallResult)({
                      journal: encodeJournal(scope, result.isError === true),
                      warnings: scope.warnings,
                      ...(scope.endTargetId === undefined
                        ? {}
                        : { endTargetId: scope.endTargetId }),
                    });
                    return { ...result, _meta: { ...result._meta, aperture: metadata } };
                  });
                } finally {
                  activeCalls.delete(call);
                }
              };
              return backend;
            },
          },
          {},
        );
      },
      catch: (cause) =>
        new BrowserHostFailed({ cause: Schema.decodeUnknownSync(Schema.Defect())(cause) }),
    }),
);
class BrowserHostFailed extends Schema.TaggedError<BrowserHostFailed>()("BrowserHostFailed", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "browser MCP host failed";
  }
}
NodeRuntime.runMain(
  Command.run(host, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
