import { readFileSync } from "node:fs";
import { type ExecutorClient, make } from "@aperture-browser/executor-client";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cdp from "./cdp.ts";
import { type Answer, request } from "./http.ts";
import { directory, freePort, run } from "./process.ts";
import { programs } from "./programs.ts";
import { until } from "./wait.ts";

export interface ExecutorOptions {
  /** What sessions offer at most, as `APERTURE_FEATURES` takes it. */
  readonly features?: readonly string[];
  /** More of the executor's environment, such as `APERTURE_SNAPSHOT_STORE`. */
  readonly env?: Record<string, string>;
}

/** A node: an executor with its own data, as `aperture-executor` runs it. */
export interface ExecutorService {
  readonly url: string;
  readonly token: string;
  /** Where the node keeps its data. */
  readonly data: string;
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
  readonly cdp: (id: string) => Effect.Effect<Cdp.Cdp, Cdp.CdpError, import("effect/Scope").Scope>;
  readonly said: () => string;
}

export const start = (options: ExecutorOptions = {}) =>
  Effect.gen(function* () {
    const dir = yield* directory;
    const port = yield* freePort;
    const executor = yield* run(`${programs}/aperture-executor`, [], {
      APERTURE_DATA_DIR: `${dir}/data`,
      APERTURE_RUNTIME_DIR: `${dir}/run`,
      APERTURE_LISTEN: `127.0.0.1:${port}`,
      APERTURE_FEATURES: (options.features ?? []).join(","),
      ...options.env,
    });
    const token = yield* until(
      "the executor writing its token",
      Effect.try(() => readFileSync(`${dir}/data/token`, "utf8").trim()),
      30_000,
    );
    const url = `http://127.0.0.1:${port}`;
    const rpc: ExecutorService["rpc"] = (method, body = {}) =>
      request(url, token, "POST", `/aperture.executor.v1.ExecutorService/${method}`, body);
    yield* until(
      "the executor answering",
      rpc("GetExecutor").pipe(Effect.map((answer) => answer.status === 200)),
      30_000,
    ).pipe(Effect.mapError((error) => new Error(`${error.message}\n${executor.said()}`)));
    return {
      url,
      token,
      data: `${dir}/data`,
      client: make({ url, token }),
      rpc,
      session: (id, method, path, body) =>
        request(url, token, method, `/sessions/${id}${path}`, body),
      cdp: (id) => Cdp.connect(`ws://127.0.0.1:${port}/sessions/${id}/cdp?token=${token}`),
      said: executor.said,
    } satisfies ExecutorService;
  });

export class Executor extends Context.Service<Executor, ExecutorService>()(
  "@aperture-browser/e2e/Executor",
) {}

/** One node for all the checks of a suite. */
export const layer = (options: ExecutorOptions = {}) => Layer.effect(Executor, start(options));
