import { type ExecutorClient, make } from "@aperture-browser/executor-client";
import type * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Cdp from "./cdp.ts";
import { type Answer, request } from "./http.ts";
import {
  DidNotStart,
  directory,
  freePort,
  kill,
  type NoPort,
  type Program,
  run,
} from "./process.ts";
import { program } from "./programs.ts";
import { type TimedOut, until } from "./wait.ts";

export interface ExecutorOptions {
  /** What sessions offer at most, as `APERTURE_FEATURES` takes it; the executor's own choice without. */
  readonly features?: readonly string[];
  /** More of the executor's environment, such as `APERTURE_SNAPSHOT_STORE`. */
  readonly env?: Record<string, string>;
  /** A directory that is there already, and may hold what another executor left; one of its own without. */
  readonly dir?: string;
}

/** What keeps an executor from starting, or from answering once it has. */
export type StartError =
  | DidNotStart
  | TimedOut
  | NoPort
  | Config.ConfigError
  | PlatformError.BadArgument
  | PlatformError.PlatformError;

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
  readonly rpc: (
    method: string,
    body?: unknown,
  ) => Effect.Effect<Answer, HttpClientError.HttpClientError>;
  /** A request below a session of the node, such as `targets`. */
  readonly session: (
    id: string,
    method: HttpMethod.HttpMethod,
    path: string,
    body?: unknown,
  ) => Effect.Effect<Answer, HttpClientError.HttpClientError>;
  /** The DevTools of a session's browser. */
  readonly cdp: (id: string) => Effect.Effect<Cdp.Cdp, Cdp.CdpError, Scope.Scope>;
  /**
   * Ends the executor as it is asked to end, and starts another where it was, on what it
   * left: its sessions go on, and the address, the token and the client stay good. With
   * options, the one that starts has those instead.
   */
  readonly restart: (options?: Omit<ExecutorOptions, "dir">) => Effect.Effect<void, StartError>;
  /** Kills the executor and its sessions' runners where they stand, as a node that loses power. */
  readonly dies: Effect.Effect<void>;
  readonly said: () => string;
}

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

/** What a runner says of itself in its runtime directory. */
export const RunnerStatus = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number }));

/**
 * Starts an executor and waits until it answers. When the scope ends its sessions are
 * deleted first: an executor that ends leaves them running for the one that starts after
 * it, and a check's sessions are for nobody.
 */
export const start = Effect.fn("Executor.start")(function* (options: ExecutorOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | ChildProcessSpawner.ChildProcessSpawner
    | Socket.WebSocketConstructor
  >();
  const dir = options.dir ?? (yield* directory);
  const port = yield* freePort;
  const scope = yield* Effect.scope;
  const url = `http://127.0.0.1:${port}`;
  const data = `${dir}/data`;
  const runtime = `${dir}/run`;

  let token = "";
  const ask = (method: HttpMethod.HttpMethod, path: string, body?: unknown) =>
    Effect.suspend(() => request(url, token, method, path, body)).pipe(Effect.provide(platform));
  const rpc: ExecutorService["rpc"] = (method, body = {}) =>
    ask("POST", `/aperture.executor.v1.ExecutorService/${method}`, body);

  const begin = Effect.fn(function* (as: Omit<ExecutorOptions, "dir">) {
    const executor = yield* run(
      yield* program("aperture-executor"),
      [],
      environment(dir, port, as),
    ).pipe(Scope.provide(scope));
    token = yield* until(
      "the executor writing its token",
      fs.readFileString(`${data}/token`).pipe(Effect.map((written) => written.trim())),
      "30 seconds",
    );
    yield* until(
      "the executor answering",
      rpc("GetExecutor").pipe(Effect.map((answer) => answer.status === 200)),
      "30 seconds",
    ).pipe(
      Effect.mapError((error) => new DidNotStart({ reason: error.message, said: executor.said() })),
    );
    return executor;
  }, Effect.provide(platform));

  let running: Program = yield* begin(options);
  const client = make({ url, token });

  const stop = Effect.suspend(() => running.ends("SIGINT"));
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

  // A runner is started as a group of its own, which its browser is in. A session that is
  // not running has no status, and a runner that is gone no group.
  const killRunner = (session: string) =>
    fs.readFileString(`${runtime}/${session}/status.json`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RunnerStatus)),
      Effect.flatMap((status) => kill(-status.pid)),
      Effect.ignore,
    );
  const killRunners = fs
    .readDirectory(runtime)
    .pipe(
      Effect.flatMap(Effect.forEach(killRunner, { discard: true })),
      Effect.ignore,
      Effect.provide(platform),
    );

  return {
    url,
    token,
    data,
    runtime,
    client,
    rpc,
    session: (id, method, path, body) => ask(method, `/sessions/${id}${path}`, body),
    cdp: (id) =>
      Cdp.connect(`ws://127.0.0.1:${port}/sessions/${id}/cdp?token=${token}`).pipe(
        Effect.provide(platform),
      ),
    restart: (as = options) =>
      Effect.gen(function* () {
        yield* stop;
        running = yield* begin(as);
      }),
    dies: Effect.suspend(() => running.ends("SIGKILL")).pipe(Effect.andThen(killRunners)),
    said: () => running.said(),
  } satisfies ExecutorService;
});

export class Executor extends Context.Service<Executor, ExecutorService>()(
  "@aperture-browser/e2e/Executor",
) {}

/** One node for all the checks of a suite. */
export const layer = (options: ExecutorOptions = {}) => Layer.effect(Executor, start(options));
