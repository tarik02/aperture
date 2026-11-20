import { readFileSync } from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cdp from "./cdp.ts";
import { type Answer, request } from "./http.ts";
import { directory, freePort, run } from "./process.ts";
import { programs } from "./programs.ts";
import { until } from "./wait.ts";

export interface RunnerOptions {
  /** What the session offers, as `--feature` takes it: `cdp`, `recordings`, … */
  readonly features?: readonly string[];
  /** More arguments for `aperture-runner serve`. */
  readonly args?: readonly string[];
}

/** A target as the session's `targets` route tells it. */
export interface Target {
  readonly id: string;
  readonly tab: number;
  readonly title: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/** A session served on its own, as `aperture-runner serve` runs it. */
export interface RunnerService {
  readonly url: string;
  readonly token: string;
  /** The session's files, where recordings and downloads go. */
  readonly files: string;
  /** The workbench, as a person opens it. */
  readonly page: (query?: Record<string, string>) => string;
  readonly request: (method: string, path: string, body?: unknown) => Effect.Effect<Answer>;
  readonly targets: Effect.Effect<readonly Target[]>;
  /** The browser's DevTools, through the session. */
  readonly cdp: Effect.Effect<Cdp.Cdp, Cdp.CdpError, import("effect/Scope").Scope>;
  /** The end of what the runner logged, for telling why a check failed. */
  readonly said: () => string;
}

/** Starts a session and waits until its first tab is there. */
export const start = (options: RunnerOptions = {}) =>
  Effect.gen(function* () {
    const dir = yield* directory;
    const port = yield* freePort;
    const features = (options.features ?? []).flatMap((feature) => ["--feature", feature]);
    const runner = yield* run(`${programs}/aperture-runner`, [
      "serve",
      "--data",
      `${dir}/session`,
      "--listen",
      `127.0.0.1:${port}`,
      "--runtime-dir",
      `${dir}/run`,
      ...features,
      ...(options.args ?? []),
    ]);
    const token = yield* until(
      "the runner writing its token",
      Effect.try(() => readFileSync(`${dir}/session/token`, "utf8").trim()),
      30_000,
    );
    const url = `http://127.0.0.1:${port}`;
    const ask: RunnerService["request"] = (method, path, body) =>
      request(url, token, method, path, body);
    const targets: RunnerService["targets"] = ask("GET", "/targets").pipe(
      Effect.map((answer) => (Array.isArray(answer.body) ? (answer.body as Target[]) : [])),
    );
    yield* until(
      "the session's first tab",
      targets.pipe(Effect.map((all) => all.length > 0)),
      60_000,
    ).pipe(Effect.mapError((error) => new Error(`${error.message}\n${runner.said()}`)));
    return {
      url,
      token,
      files: `${dir}/session/files`,
      page: (query = {}) => `${url}/?${new URLSearchParams({ token, ...query }).toString()}`,
      request: ask,
      targets,
      cdp: Cdp.connect(`ws://127.0.0.1:${port}/cdp?token=${token}`),
      said: runner.said,
    } satisfies RunnerService;
  });

export class Runner extends Context.Service<Runner, RunnerService>()(
  "@aperture-browser/e2e/Runner",
) {}

/** One session for all the checks of a suite. */
export const layer = (options: RunnerOptions = {}) => Layer.effect(Runner, start(options));
