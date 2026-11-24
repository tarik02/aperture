import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Cdp from "./cdp.ts";
import { type Answer, request } from "./http.ts";
import { DidNotStart, directory, run } from "./process.ts";
import { program } from "./programs.ts";
import { until } from "./wait.ts";

export interface RunnerOptions {
  /** What the session offers, as `--feature` takes it: `cdp`, `recordings`, … */
  readonly features?: readonly string[];
  /** More arguments for `aperture-runner serve`. */
  readonly args?: readonly string[];
}

/** A target as the session's `targets` route tells it. */
export const Target = Schema.Struct({
  id: Schema.String,
  tab: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  scale: Schema.Number,
  /** How the tab's pages are shown, as it was set: `auto`, `desktop` or `mobile`. */
  mode: Schema.String,
  /** Its pages are shown as on a phone now. */
  mobile: Schema.Boolean,
});
export type Target = typeof Target.Type;

const targetsOf = Schema.decodeUnknownEffect(Schema.Array(Target));

/** The targets a `targets` route answered with; none while it does not answer with a list. */
export const targetsIn = (answer: Answer) =>
  Array.isArray(answer.body) ? targetsOf(answer.body) : Effect.succeed<readonly Target[]>([]);

/** A session served on its own, as `aperture-runner serve` runs it. */
export interface RunnerService {
  readonly url: string;
  readonly token: string;
  /** The session's files, where recordings and downloads go. */
  readonly files: string;
  /** The workbench, as a person opens it. */
  readonly page: (query?: Record<string, string>) => string;
  readonly request: (
    method: HttpMethod.HttpMethod,
    path: string,
    body?: unknown,
  ) => Effect.Effect<Answer, HttpClientError.HttpClientError>;
  readonly targets: Effect.Effect<
    readonly Target[],
    HttpClientError.HttpClientError | Schema.SchemaError
  >;
  /** The browser's DevTools, through the session. */
  readonly cdp: Effect.Effect<Cdp.Cdp, Cdp.CdpError, Scope.Scope>;
  /** The end of what the runner logged, for telling why a check failed. */
  readonly said: () => string;
}

/** Starts a session and waits until its first tab is there. */
export const start = Effect.fn("Runner.start")(function* (options: RunnerOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const webSockets = yield* Socket.WebSocketConstructor;
  const dir = yield* directory;
  const features = (options.features ?? []).flatMap((feature) => ["--feature", feature]);
  const runner = yield* run(yield* program("aperture-runner"), [
    "serve",
    "--data",
    `${dir}/session`,
    // A port the system chooses as the runner listens: one found free here before may be
    // another's by then, as another file's checks start sessions of their own.
    "--listen",
    "127.0.0.1:0",
    "--runtime-dir",
    `${dir}/run`,
    ...features,
    ...(options.args ?? []),
  ]);
  const token = yield* until(
    "the runner writing its token",
    fs
      .readFileString(`${dir}/session/token`)
      .pipe(Effect.map((written) => written.trim() || undefined)),
    "30 seconds",
  );
  const address = yield* until(
    "the runner writing where it listens",
    fs
      .readFileString(`${dir}/session/address`)
      .pipe(Effect.map((written) => written.trim() || undefined)),
    "30 seconds",
  );
  const url = `http://${address}`;
  const ask: RunnerService["request"] = (method, path, body) =>
    request(url, token, method, path, body).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
  const targets: RunnerService["targets"] = ask("GET", "/targets").pipe(Effect.flatMap(targetsIn));
  yield* until(
    "the session's first tab",
    targets.pipe(Effect.map((all) => all.length > 0)),
    "1 minute",
  ).pipe(
    Effect.mapError((error) => new DidNotStart({ reason: error.message, said: runner.said() })),
  );
  return {
    url,
    token,
    files: `${dir}/session/files`,
    page: (query = {}) => `${url}/?${new URLSearchParams({ token, ...query }).toString()}`,
    request: ask,
    targets,
    cdp: Cdp.connect(`ws://${address}/cdp?token=${token}`).pipe(
      Effect.provideService(Socket.WebSocketConstructor, webSockets),
    ),
    said: runner.said,
  } satisfies RunnerService;
});

export class Runner extends Context.Service<Runner, RunnerService>()(
  "@aperture-browser/e2e/Runner",
) {}

/** One session for all the checks of a suite. */
export const layer = (options: RunnerOptions = {}) => Layer.effect(Runner, start(options));
