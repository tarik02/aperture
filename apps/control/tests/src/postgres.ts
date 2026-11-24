import { DidNotStart, directory, freePort, run } from "@aperture-browser/e2e/src/process.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export interface PostgresService {
  /** An empty database of the suite's own. */
  readonly url: string;
}

/** Whether a program that is run for what it does did it. */
const succeeds = (program: string, args: ReadonlyArray<string>) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.exitCode(
      ChildProcess.make(program, args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
    ),
  ).pipe(Effect.map((code) => code === 0));

/**
 * A PostgreSQL server on a directory of its own, for as long as the scope lasts. The
 * programs are the dev shell's.
 */
export const start = Effect.gen(function* () {
  const dir = yield* directory;
  const data = `${dir}/data`;
  const port = yield* freePort;
  const made = yield* succeeds("initdb", [
    "--pgdata",
    data,
    "--username",
    "postgres",
    "--auth",
    "trust",
    "--encoding",
    "UTF8",
    "--no-sync",
  ]);
  if (!made) {
    return yield* new DidNotStart({ reason: `initdb made no database in ${data}`, said: "" });
  }
  const server = yield* run("postgres", [
    "-D",
    data,
    "-c",
    "listen_addresses=127.0.0.1",
    "-c",
    `port=${port}`,
    "-c",
    `unix_socket_directories=${dir}`,
    // What a check wrote is for nobody once the check is over.
    "-c",
    "fsync=off",
  ]);
  // Asked to end at once: it would wait for whoever is still connected otherwise.
  yield* Effect.addFinalizer(() => server.ends("SIGINT"));
  yield* until(
    "the database taking connections",
    succeeds("pg_isready", ["--host", "127.0.0.1", "--port", String(port)]),
    "30 seconds",
  );
  return { url: `postgres://postgres@127.0.0.1:${port}/postgres` } satisfies PostgresService;
});

export class Postgres extends Context.Service<Postgres, PostgresService>()(
  "@aperture-browser/control/tests/Postgres",
) {}

/** One database for all the checks of a suite. */
export const layer = Layer.effect(Postgres, start);
