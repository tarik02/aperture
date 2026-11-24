import * as UrlPath from "@aperture-browser/shared/url-path";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Executor } from "../src/executor.ts";
import * as Mcp from "../src/mcp.ts";
import * as Node from "../src/node.ts";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import * as Tickets from "../src/tickets.ts";
import { type Page, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens, until } from "../src/wait.ts";
import { openByAutomation, tabsOfAutomation } from "../src/workbench.ts";

const node = Layer.mergeAll(
  Node.layer({ features: ["cdp", "mcp", "recordings"] }),
  ViewerLive.layer,
);

const AGENT_PAGE =
  "data:text/html,<title>agent tab</title><h1>opened by the agent</h1><input id=q autofocus>";

const Files = Schema.fromJsonString(
  Schema.Struct({
    files: Schema.Array(
      Schema.Struct({ path: Schema.String, size: Schema.Number, absolute: Schema.String }),
    ),
  }),
);

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

      agent = yield* Mcp.connect(
        UrlPath.make`${UrlPath.raw(executor.url)}/sessions/${session}`,
        executor.token,
      );
      const tools = yield* agent.tools;
      expect(tools).toEqual(
        expect.arrayContaining(["navigate", "click", "tabs", "execute", "recording", "files"]),
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

  it.effect("files lists what the session keeps, the screenshot among it", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      expect((yield* executor.session(session, "POST", "/screenshots", {})).status).toBe(201);
      const listed = yield* agent
        .call("files", { directory: "screenshots" })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Files)));
      const [shot] = listed.files.filter((file) => file.path.endsWith(".png"));
      expect(shot?.path).toMatch(/^screenshots\/[^/]+\.png$/u);
      expect(shot?.size).toBeGreaterThan(0);
      // The path is where the session serves the file, and where its own tools find it.
      const served = yield* executor.session(session, "GET", `/files/${shot?.path ?? ""}`);
      expect(served.status).toBe(200);
      expect(shot?.absolute.endsWith(`/${shot.path}`)).toBe(true);
      const all = yield* agent
        .call("files")
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Files)));
      expect(all.files.length).toBeGreaterThanOrEqual(listed.files.length);
      const unknown = yield* Effect.flip(agent.call("files", { directory: "profile" }));
      expect(unknown.reason).toMatch(/no directory profile/u);
      const notAnUpload = yield* Effect.flip(
        agent.call("files", { action: "delete", path: shot?.path }),
      );
      expect(notAnUpload.reason).toMatch(/only an upload/u);
      const outside = yield* Effect.flip(
        agent.call("files", { action: "delete", path: "uploads/../screenshots/x.png" }),
      );
      expect(outside.reason).toMatch(/no upload's name/u);
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

/** Who is in the session and who holds which tab, as far as these checks look. */
const Present = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({
      id: Schema.Unknown,
      name: Schema.optional(Schema.String),
      agent: Schema.optional(Schema.Boolean),
    }),
  ),
  held: Schema.optional(
    Schema.Array(Schema.Struct({ tab: Schema.Number, holder: Schema.Unknown })),
  ),
});

const PRESSED = "data:text/html,<title>pressed by automation</title><button>press</button>";

suite(Tickets.layer({ features: ["mcp"] }))("who acts through a session's MCP", (it) => {
  let ada: Mcp.Mcp;

  /** Someone who watches the session for as long as a check lasts, and sees who is in it. */
  const watching = Effect.gen(function* () {
    const runner = yield* Runner.Runner;
    return yield* Tickets.join(runner, runner.token);
  });

  /** What the session's presence tells the watcher at the moment it is looked at. */
  const present = (watcher: Tickets.Member) =>
    Effect.suspend(() => Schema.decodeUnknownEffect(Present)(watcher.seen["presence"]));

  /** Waits for the automation's members to be the ones of these names. */
  const automation = (watcher: Tickets.Member, what: string, expected: readonly string[]) =>
    until(
      what,
      present(watcher).pipe(
        Effect.map(
          (presence) =>
            presence.members
              .filter((member) => member.agent === true)
              .map((member) => member.name)
              .toSorted()
              .join() === expected.join(),
        ),
      ),
    );

  const calling = Effect.fn(function* (claims: Tickets.Claims) {
    const runner = yield* Runner.Runner;
    const tickets = yield* Tickets.Tickets;
    return yield* Mcp.connect(runner.url, yield* tickets.ticket({ mcp: "rw" }, claims));
  });

  it.effect("the session's own token acts as the automation itself", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const watcher = yield* watching;
      const operator = yield* Mcp.connect(runner.url, runner.token);
      yield* operator.call("tabs", {});
      yield* automation(watcher, "the automation alone being there", ["Agent"]);
    }),
  );

  it.effect("whoever calls with a ticket is there under their name, as automation", () =>
    Effect.gen(function* () {
      const watcher = yield* watching;
      ada = yield* calling({ sub: "ada", name: "Ada" });
      // Asking what tools there are is no acting in the session.
      yield* ada.tools;
      yield* automation(watcher, "nobody having joined before a call", ["Agent"]);
      yield* ada.call("tabs", {});
      yield* automation(watcher, "Ada's automation having joined", ["Ada", "Agent"]);
    }),
  );

  it.effect("a caller is one member over however many connections, and each caller their own", () =>
    Effect.gen(function* () {
      const watcher = yield* watching;
      const again = yield* calling({ sub: "ada", name: "Ada" });
      yield* again.call("tabs", {});
      const grace = yield* calling({ sub: "grace", name: "Grace" });
      yield* grace.call("tabs", {});
      yield* automation(watcher, "Grace's automation having joined beside Ada's one", [
        "Ada",
        "Agent",
        "Grace",
      ]);
    }),
  );

  it.effect("a tab is held by whoever's automation gives it input", () =>
    Effect.gen(function* () {
      const watcher = yield* watching;
      const tab = yield* openByAutomation(ada, PRESSED);
      yield* ada.call("click", { tab, selector: "button" });
      const lease = yield* until(
        "the tab being held",
        present(watcher).pipe(
          Effect.map((presence) => presence.held?.find((held) => held.tab === tab)),
        ),
      );
      const { members } = yield* present(watcher);
      expect(members.find((member) => member.id === lease.holder)).toMatchObject({
        name: "Ada",
        agent: true,
      });
    }),
  );
});
