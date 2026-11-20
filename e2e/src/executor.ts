import { readdirSync, readFileSync } from "node:fs";
import { type ExecutorClient, make } from "@aperture-browser/executor-client";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Cdp from "./cdp.ts";
import { type Answer, request } from "./http.ts";
import { directory, ended, freePort, type Program, run } from "./process.ts";
import { programs } from "./programs.ts";
import { until } from "./wait.ts";

export interface ExecutorOptions {
  /** What sessions offer at most, as `APERTURE_FEATURES` takes it; the executor's own choice without. */
  readonly features?: readonly string[];
  /** More of the executor's environment, such as `APERTURE_SNAPSHOT_STORE`. */
  readonly env?: Record<string, string>;
  /** A directory that is there already, and may hold what another executor left; one of its own without. */
  readonly dir?: string;
}

/** A node: an executor with its own data, as `aperture-executor` runs it. */
export interface ExecutorService {
  readonly url: string;
  readonly token: string;
  /** Where the node keeps its data. */
  readonly data: string;
  /** Where the node keeps the state of its running sessions, a directory for each. */
  readonly runtime: string;
  readonly client: ExecutorClient;
  /** A call as JSON, for what is checked of an answer the client does not give: a refusal's status. */
  readonly rpc: (method: string, body?: unknown) => Effect.Effect<Answer>;
  /** A request below a session of the node, such as `targets`. */
  readonly session: (
    id: string,
    method: string,
    path: string,
    body?: unknown,
  ) => Effect.Effect<Answer>;
  /** The DevTools of a session's browser. */
  readonly cdp: (id: string) => Effect.Effect<Cdp.Cdp, Cdp.CdpError, Scope.Scope>;
  /**
   * Ends the executor as it is asked to end, and starts another where it was, on what it
   * left: its sessions go on, and the address, the token and the client stay good. With
   * options, the one that starts has those instead.
   */
  readonly restart: (options?: Omit<ExecutorOptions, "dir">) => Effect.Effect<void, Error>;
  /** Kills the executor and its sessions' runners where they stand, as a node that loses power. */
  readonly dies: Effect.Effect<void>;
  readonly said: () => string;
}

/** How long an executor gets to end once it is asked to. */
const ENDS_WITHIN_MS = 10_000;

const environment = (
  dir: string,
  port: number,
  options: Omit<ExecutorOptions, "dir">,
): Record<string, string> => ({
  APERTURE_DATA_DIR: `${dir}/data`,
  APERTURE_RUNTIME_DIR: `${dir}/run`,
  APERTURE_LISTEN: `127.0.0.1:${port}`,
  // Given no list at all the executor offers what it offers by itself; an empty one it refuses.
  ...(options.features === undefined || options.features.length === 0
    ? {}
    : { APERTURE_FEATURES: options.features.join(",") }),
  ...options.env,
});

/**
 * Starts an executor and waits until it answers. When the scope ends its sessions are
 * deleted first: an executor that ends leaves them running for the one that starts after
 * it, and a check's sessions are for nobody.
 */
export const start = (options: ExecutorOptions = {}) =>
  Effect.gen(function* () {
    const dir = options.dir ?? (yield* directory);
    const port = yield* freePort;
    const scope = yield* Effect.scope;
    const url = `http://127.0.0.1:${port}`;
    const data = `${dir}/data`;
    const runtime = `${dir}/run`;

    let token = "";
    const rpc: ExecutorService["rpc"] = (method, body = {}) =>
      request(url, token, "POST", `/aperture.executor.v1.ExecutorService/${method}`, body);

    const begin = (as: Omit<ExecutorOptions, "dir">) =>
      Effect.gen(function* () {
        const program = yield* run(
          `${programs}/aperture-executor`,
          [],
          environment(dir, port, as),
        ).pipe(Scope.provide(scope));
        token = yield* until(
          "the executor writing its token",
          Effect.try(() => readFileSync(`${data}/token`, "utf8").trim()),
          30_000,
        );
        yield* until(
          "the executor answering",
          rpc("GetExecutor").pipe(Effect.map((answer) => answer.status === 200)),
          30_000,
        ).pipe(Effect.mapError((error) => new Error(`${error.message}\n${program.said()}`)));
        return program;
      });

    let running: Program = yield* begin(options);
    const client = make({ url, token });

    const stop = Effect.suspend(() => ended(running.child, "SIGINT", ENDS_WITHIN_MS));
    yield* Effect.addFinalizer(() =>
      client.sessions.list.pipe(
        Effect.flatMap((sessions) =>
          Effect.forEach(sessions, (session) => Effect.ignore(client.sessions.delete(session.id)), {
            discard: true,
          }),
        ),
        Effect.ignore,
        Effect.andThen(stop),
      ),
    );

    return {
      url,
      token,
      data,
      runtime,
      client,
      rpc,
      session: (id, method, path, body) =>
        request(url, token, method, `/sessions/${id}${path}`, body),
      cdp: (id) => Cdp.connect(`ws://127.0.0.1:${port}/sessions/${id}/cdp?token=${token}`),
      restart: (as = options) =>
        Effect.gen(function* () {
          yield* stop;
          running = yield* begin(as);
        }),
      dies: Effect.suspend(() => ended(running.child, "SIGKILL", ENDS_WITHIN_MS)).pipe(
        Effect.andThen(Effect.sync(() => killRunners(runtime))),
      ),
      said: () => running.said(),
    } satisfies ExecutorService;
  });

const killRunners = (runtime: string) => {
  for (const session of readdirSync(runtime)) {
    try {
      const status = JSON.parse(readFileSync(`${runtime}/${session}/status.json`, "utf8")) as {
        readonly pid: number;
      };
      // A runner is started as a group of its own, which its browser is in.
      process.kill(-status.pid, "SIGKILL");
    } catch {
      // A session that is not running has no status, and a runner that is gone no group.
    }
  }
};

export class Executor extends Context.Service<Executor, ExecutorService>()(
  "@aperture-browser/e2e/Executor",
) {}

/** One node for all the checks of a suite. */
export const layer = (options: ExecutorOptions = {}) => Layer.effect(Executor, start(options));
