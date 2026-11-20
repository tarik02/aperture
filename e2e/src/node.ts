import { proto } from "@aperture-browser/executor-client";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Cdp from "./cdp.ts";
import * as Executor from "./executor.ts";
import * as Http from "./http.ts";
import { output } from "./process.ts";
import { type Target, targetsIn } from "./runner.ts";
import type { Page, ViewerService } from "./viewer.ts";
import { until } from "./wait.ts";

export const SessionState = proto.SessionState;

/**
 * The scope of a suite. What a check starts in it is there for the checks after it: a
 * DevTools connection, a proxy, a tunnel's end.
 */
export class Lasting extends Context.Service<Lasting, Scope.Scope>()(
  "@aperture-browser/e2e/Lasting",
) {}

/** Has what an effect acquires last as long as the suite, not the check that asked. */
export const lasting = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope> | Lasting> =>
  Lasting.use((scope) => Scope.provide(effect, scope));

/** One node for all the checks of a suite, with the suite's scope for what is to last as long. */
export const layer = (options: Executor.ExecutorOptions = {}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const executor = yield* Executor.start(options);
      const scope = yield* Effect.scope;
      return Context.make(Executor.Executor, executor).pipe(Context.add(Lasting, scope));
    }),
  );

/** A process of a node, as `ps` tells it. */
export interface Process {
  readonly pid: number;
  readonly command: string;
}

/**
 * The processes that name something below the node's directory: its sessions' runners,
 * sandboxes, browsers and desktops. The executor is told where its data is by its
 * environment, and so is not among them.
 */
export const processes = Effect.fn("Node.processes")(function* (
  executor: Executor.ExecutorService,
) {
  const path = yield* Path.Path;
  const below = `${path.dirname(executor.data)}/`;
  const told = yield* output("ps", ["-eo", "pid=,args="]);
  return told
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(below))
    .map((line): Process => {
      const [pid = "", ...command] = line.split(" ");
      return { pid: Number(pid), command: command.join(" ") };
    });
});

/** The processes of one session of the node. */
export const processesOf = (executor: Executor.ExecutorService, sessionId: string) =>
  processes(executor).pipe(
    Effect.map((all) => all.filter((process) => process.command.includes(sessionId))),
  );

/** The sandbox a session's browser runs in, which takes the browser with it when it dies. */
export const browserOf = (executor: Executor.ExecutorService, sessionId: string) => {
  const profile = `${executor.data}/sessions/${sessionId}/`;
  return processes(executor).pipe(
    Effect.map((all) =>
      all.find(
        (process) => /(^|\/)bwrap /u.test(process.command) && process.command.includes(profile),
      ),
    ),
  );
};

/** The process that runs a session, as the runner itself says in its runtime directory. */
export const runnerOf = Effect.fn("Node.runnerOf")(function* (
  executor: Executor.ExecutorService,
  sessionId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const status = yield* fs.readFileString(path.join(executor.runtime, sessionId, "status.json"));
  return (yield* Schema.decodeUnknownEffect(Executor.RunnerStatus)(status)).pid;
});

/** Waits until a session is in a state, and gives the session as it is then. */
export const inState = (
  executor: Executor.ExecutorService,
  sessionId: string,
  state: proto.SessionState,
  within: Duration.Input = "30 seconds",
) =>
  until(
    `session ${sessionId} being ${proto.SessionState[state]}`,
    executor.client.sessions
      .get(sessionId)
      .pipe(Effect.map((session) => session.state === state && session)),
    within,
  );

/** A session's targets, as its `targets` route tells them. */
export const targets = (executor: Executor.ExecutorService, sessionId: string) =>
  executor.session(sessionId, "GET", "/targets").pipe(Effect.flatMap(targetsIn));

/** Waits until the session's targets are as `wanted` says, and gives them. */
export const targetsOnce = (
  executor: Executor.ExecutorService,
  sessionId: string,
  what: string,
  wanted: (all: readonly Target[]) => boolean,
) =>
  until(
    what,
    targets(executor, sessionId).pipe(Effect.map((all) => wanted(all) && all)),
    "20 seconds",
  );

/** What a session route answers with as bytes: a picture, a recording. */
export const bytes = (executor: Executor.ExecutorService, sessionId: string, path: string) =>
  Http.bytes(`${executor.url}/sessions/${sessionId}${path}`, executor.token);

/**
 * A page to do things to: a heading, a button at (100, 300) and a field at (100, 450), on
 * a page tall enough to scroll. Its title says what was done last: `clicked`, or
 * `typed:` and what the field holds.
 */
export const TRIAL_PAGE =
  "data:text/html," +
  "<body style='margin:0;background:%23246;color:white;font:48px sans-serif'>" +
  "<h1>Session B</h1>" +
  "<button style='position:absolute;left:100px;top:300px;width:300px;height:100px;font-size:32px'" +
  ` onclick="document.title='clicked'">click me</button>` +
  "<input id=i style='position:absolute;left:100px;top:450px;width:400px;font-size:32px'" +
  ` oninput="document.title='typed:'+this.value">` +
  "<div style='height:3000px'></div>";

/** A page of a session that a suite opened, attached for as long as the suite lasts. */
export interface Opened {
  /** The page's target id. */
  readonly id: string;
  readonly tab: number;
  readonly page: Cdp.Attached;
  /** The browser's DevTools the page is attached through. */
  readonly cdp: Cdp.Cdp;
}

const Created = Schema.Struct({ targetId: Schema.String });

/** Opens a page in a session and waits until it is a target of the session. */
export const open = (executor: Executor.ExecutorService, sessionId: string, url: string) =>
  Effect.gen(function* () {
    const cdp = yield* lasting(executor.cdp(sessionId));
    const created = yield* cdp.call("Target.createTarget", { url }, Created);
    const page = yield* cdp.attach(created.targetId);
    const all = yield* targetsOnce(executor, sessionId, "the opened page being a target", (all) =>
      all.some((target) => target.id === created.targetId),
    );
    const target = all.find((one) => one.id === created.targetId)!;
    return { id: target.id, tab: target.tab, page, cdp } satisfies Opened;
  });

/** Where the workbench of a session of the node is, for whoever holds the operator token. */
export const workbench = (
  executor: Executor.ExecutorService,
  sessionId: string,
  query: Record<string, string> = {},
) =>
  `${executor.url}/sessions/${sessionId}?${new URLSearchParams({
    token: executor.token,
    // Whoever watches here leaves the targets the size they have.
    fit: "0",
    ...query,
  }).toString()}`;

// The workbench keeps its WebRTC connection to itself; `peers` has every one a page made.
const CATCH_PEERS = `(() => {
  const Native = window.RTCPeerConnection;
  window.peers = [];
  window.RTCPeerConnection = class extends Native {
    constructor(...given) {
      super(...given);
      window.peers.push(this);
    }
  };
})()`;

/**
 * Opens a session's workbench as `viewer.open` does, with every WebRTC connection the page
 * makes caught in `window.peers`. The page is at the node's address before it is at the
 * workbench: a script that is in a page before the page runs is added from a page.
 */
export const watch = (
  viewer: ViewerService,
  executor: Executor.ExecutorService,
  sessionId: string,
  query: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const page = yield* viewer.open(`${executor.url}/`);
    yield* page.cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: CATCH_PEERS });
    yield* page.cdp.call("Page.navigate", { url: workbench(executor, sessionId, query) });
    return page;
  });

/** The width and height of the picture a workbench shows, by the surface that shows it. */
export const pictureSize = (page: Page, surface: "video" | "canvas") =>
  page.evaluate(
    surface === "video"
      ? "(() => { const v = document.querySelector('[data-aperture-surface=video]'); return v ? v.videoWidth + 'x' + v.videoHeight : '' })()"
      : "(() => { const c = document.querySelector('[data-aperture-surface=canvas]'); return c ? c.width + 'x' + c.height : '' })()",
    Schema.String,
  );

/**
 * Clicks in a workbench where a point of the target's page is shown. The target is
 * `width` pixels wide and the picture shows all of it.
 */
export const clickInPicture = (
  page: Page,
  surface: "video" | "canvas",
  at: { readonly x: number; readonly y: number },
  size = { width: 1280, height: 720 },
) =>
  Effect.gen(function* () {
    const shown = yield* page.box(`[data-aperture-surface=${surface}]`);
    yield* page.clickAt(
      shown.left + at.x * (shown.width / size.width),
      shown.top + at.y * (shown.height / size.height),
    );
  });
