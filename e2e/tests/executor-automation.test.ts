import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Executor } from "../src/executor.ts";
import * as Mcp from "../src/mcp.ts";
import * as Node from "../src/node.ts";
import { suite } from "../src/suite.ts";
import { type Page, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens } from "../src/wait.ts";
import { openByAutomation, tabsOfAutomation } from "../src/workbench.ts";

const node = Layer.mergeAll(
  Node.layer({ features: ["cdp", "mcp", "recordings"] }),
  ViewerLive.layer,
);

const AGENT_PAGE =
  "data:text/html,<title>agent tab</title><h1>opened by the agent</h1><input id=q autofocus>";

suite(node)("automation of a session of a node, over MCP", (it) => {
  let session: string;
  let opened: Node.Opened;
  let watcher: Page;
  let agent: Mcp.Mcp;
  let agentTab: number;

  const title = () => opened.page.evaluate("document.title");

  it.effect("a session serves its tools over MCP", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const viewer = yield* Viewer;
      session = (yield* executor.client.sessions.create()).id;
      opened = yield* Node.open(executor, session, Node.TRIAL_PAGE);
      // A person watches the same page while the agent works on it.
      watcher = yield* Node.watch(viewer, executor, session);
      yield* happens(snapshot(watcher, `s.selected === ${opened.tab}`));

      agent = yield* Mcp.connect(`${executor.url}/sessions/${session}`, executor.token);
      const tools = yield* agent.tools;
      expect(tools).toEqual(
        expect.arrayContaining(["navigate", "click", "tabs", "execute", "recording"]),
      );
    }),
  );

  it.effect("tabs lists the session's targets", () =>
    Effect.gen(function* () {
      const listed = yield* tabsOfAutomation(agent);
      expect(listed).toHaveLength(2);
      expect(listed.map((tab) => tab.target)).toContain(opened.id);
    }),
  );

  it.effect("snapshot reads the page", () =>
    Effect.gen(function* () {
      const read = yield* agent.call("snapshot", { tab: opened.id });
      expect(read).toMatch(/click me/u);
    }),
  );

  it.effect("the viewer sees automation move the pointer", () =>
    Effect.gen(function* () {
      yield* opened.page.evaluate("document.querySelector('button').style.cursor = 'pointer'");
      yield* agent.call("hover", { tab: opened.id, selector: "button" });
      const seen = yield* happens(snapshot(watcher, "s.cursor === 'pointer'"), "5 seconds");
      expect(seen).toBe(true);
    }),
  );

  it.effect("click reaches the page", () =>
    Effect.gen(function* () {
      yield* opened.page.evaluate("document.title = 'reset'");
      yield* agent.call("click", { tab: opened.id, selector: "button" });
      expect(yield* title()).toBe("clicked");
    }),
  );

  it.effect("fill reaches the page", () =>
    Effect.gen(function* () {
      yield* agent.call("fill", { tab: opened.id, selector: "#i", value: "by agent" });
      expect(yield* title()).toBe("typed:by agent");
    }),
  );

  it.effect("press types through the keyboard", () =>
    Effect.gen(function* () {
      yield* agent.call("click", { tab: opened.id, selector: "#i" });
      yield* agent.call("press", { tab: opened.id, key: "x" });
      expect(yield* title()).toBe("typed:by agentx");
    }),
  );

  it.effect("screenshot returns an image", () =>
    Effect.gen(function* () {
      const content = yield* agent.content("screenshot", { tab: opened.id });
      const image = content.find((item) => item.type === "image");
      expect(image?.data?.length ?? 0).toBeGreaterThan(1000);
    }),
  );

  it.effect("navigate without a tab opens a target", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      agentTab = yield* openByAutomation(agent, AGENT_PAGE);

      // A page's title is told a moment after the page is.
      const all = yield* Node.targetsOnce(
        executor,
        session,
        "the agent's tab having its title",
        (all) => all.some((target) => target.title === "agent tab"),
      );
      expect(all).toHaveLength(3);
      expect(all.find((target) => target.title === "agent tab")?.tab).toBe(agentTab);
    }),
  );

  it.effect("keys reach a tab no pointer touched", () =>
    Effect.gen(function* () {
      yield* agent.call("press", { tab: agentTab, selector: "#q", key: "k" });
      const typed = yield* agent.call("eval", { tab: agentTab, expression: "q.value" });
      expect(typed).toBe('"k"');
    }),
  );

  it.effect("execute runs a script against a tab", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const all = yield* Node.targets(executor, session);
      const target = all.find((one) => one.tab === agentTab);
      const ran = yield* agent.call("execute", {
        code: "return await page.title()",
        tab: target?.id,
      });
      expect(ran).toMatch(/agent tab/u);
    }),
  );

  it.effect("tabs close closes the target", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const before = yield* Node.targets(executor, session);
      const target = before.find((one) => one.tab === agentTab);
      yield* agent.call("tabs", { action: "close", tab: target?.id });

      const closed = yield* happens(
        Node.targets(executor, session).pipe(Effect.map((all) => all.length === 2)),
      );
      expect(closed).toBe(true);
    }),
  );
});
