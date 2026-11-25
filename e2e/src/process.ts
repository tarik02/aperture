import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Failures from "./failures.ts";

/** How long a program gets to end by itself once asked to. */
const ENDS_WITHIN = Duration.seconds(10);
/** How much of what a program said is kept to tell when a check fails. */
const SAID_MOST = 64 * 1024;

export type Signal = ChildProcess.Signal;

export interface Program {
  readonly pid: number;
  /** The end of what it wrote to its error output. */
  readonly said: () => string;
  /**
   * Asks it to end with a signal and waits until it has; one that has not ended in time
   * is killed. A program that ended already is left alone.
   */
  readonly ends: (signal: Signal) => Effect.Effect<void>;
}

/**
 * Where whoever runs the checks asked for the programs' logs to be kept, if they did: for
 * looking into a check that fails once in many runs, after the run.
 */
export const logsDirectory = Config.String("APERTURE_E2E_LOGS").pipe(
  Config.withDefault(""),
  Effect.orElseSucceed(() => ""),
  Effect.map((directory) => (directory === "" ? undefined : directory)),
);

/** Runs a program for as long as the scope lasts. */
export const run = Effect.fn("run")(function* (
  program: string,
  args: readonly string[],
  env: Record<string, string> = {},
) {
  const handle = yield* ChildProcess.make(program, args, {
    env,
    extendEnv: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // The signal is for the program alone: what it started ends as the program has it end.
    detached: false,
    killSignal: "SIGTERM",
    forceKillAfter: ENDS_WITHIN,
  });
  let said = "";
  const fs = yield* FileSystem.FileSystem;
  const logs = yield* logsDirectory;
  const name = program.split("/").at(-1) ?? "program";
  const log = logs === undefined ? undefined : `${logs}/${name}-${handle.pid}.log`;
  // Both of its outputs: which one a program logs to is the program's own choice.
  yield* Stream.merge(handle.stdout, handle.stderr).pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        said = (said + chunk).slice(-SAID_MOST);
        if (log !== undefined) {
          yield* Effect.ignore(fs.writeFileString(log, chunk, { flag: "a" }));
        }
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* Failures.witness(
    Effect.sync(() => [{ name: `${name}-${handle.pid}.log`, content: said }]),
  );
  const ends: Program["ends"] = (signal) =>
    handle.isRunning.pipe(
      Effect.flatMap((running) =>
        running ? handle.kill({ killSignal: signal, forceKillAfter: ENDS_WITHIN }) : Effect.void,
      ),
      Effect.ignore,
    );
  return { pid: handle.pid, said: () => said, ends } satisfies Program;
});

/** A program that did not come to do what it was started for; what it said tells why. */
export class DidNotStart extends Schema.TaggedError<DidNotStart>()("DidNotStart", {
  reason: Schema.String,
  said: Schema.String,
}) {
  override get message() {
    return `${this.reason}\n${this.said}`;
  }
}

/** What a program wrote to its output, for one that is run for what it says. */
export const output = (program: string, args: readonly string[]) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.string(ChildProcess.make(program, args, { stdin: "ignore", stderr: "ignore" })),
  );

/**
 * Kills a process that something else started, where it stands; a group of them by the
 * group's id negated. One that is gone already is left alone.
 */
export const kill = (pid: number) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.exitCode(
      ChildProcess.make("kill", ["-KILL", "--", String(pid)], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    ),
  ).pipe(Effect.ignore);

/** No port could be told. */
export class NoPort extends Schema.TaggedError<NoPort>()("NoPort", {
  reason: Schema.String,
}) {
  override get message() {
    return `no port was given: ${this.reason}`;
  }
}

/**
 * The ports handed out: below those the kernel gives out by itself, 32768 and up as Linux
 * has it, to the near end of each connection made and to whatever listens on any port. A
 * port of those that was found free may be taken by a connection of anything on the
 * machine before what it was found for listens on it.
 */
const FIRST_PORT = 10_000;
/** Each worker of a run has ports of its own, so that no two hand out the same one. */
const PORTS_EACH = 1_400;
const WORKERS_MOST = 16;
/** Where the ports of the worker this runs in begin. */
const firstOfWorker = Config.Int("VITEST_POOL_ID").pipe(
  Effect.map((id) => (id >= 1 ? (id - 1) % WORKERS_MOST : 0)),
  Effect.orElseSucceed(() => 0),
  Effect.map((worker) => FIRST_PORT + worker * PORTS_EACH),
);
/**
 * Where this worker goes on from: a file's modules are loaded anew, and what the file
 * before started may still be ending on the ports it was handed.
 */
let handed = Math.floor(Math.random() * PORTS_EACH);

/** Whether nothing listens on a port right now. */
const unused = (port: number) =>
  NodeSocketServer.make({ port, host: "127.0.0.1" }).pipe(
    Effect.scoped,
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );

/** A port nothing listens on right now, and that nothing is given unless it asks for it. */
export const freePort = Effect.gen(function* () {
  const first = yield* firstOfWorker;
  for (let tried = 0; tried < PORTS_EACH; tried += 1) {
    const port = first + (handed % PORTS_EACH);
    handed += 1;
    if (yield* unused(port)) {
      return port;
    }
  }
  return yield* new NoPort({
    reason: `something listens on each of ${first}–${first + PORTS_EACH - 1}`,
  });
});

/** A directory of the scope's own, gone when it ends. Its path is short: sockets go below it. */
export const directory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  // `makeTempDirectoryScoped` removes once and dies of what is in its way: what ran here
  // may still be writing its last as it ends.
  // Not wherever temporary files go: a dev shell puts them below a path as long as a
  // socket's whole path may be.
  return yield* Effect.acquireRelease(
    fs.makeTempDirectory({ directory: "/tmp", prefix: "ap-e2e-" }),
    (path) =>
      fs
        .remove(path, { recursive: true, force: true })
        .pipe(
          Effect.retry(Schedule.spaced("200 millis").pipe(Schedule.upTo({ times: 10 }))),
          Effect.ignore,
        ),
  );
});
