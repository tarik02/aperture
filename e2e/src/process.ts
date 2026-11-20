import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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
    stdout: "ignore",
    stderr: "pipe",
    // The signal is for the program alone: what it started ends as the program has it end.
    detached: false,
    killSignal: "SIGTERM",
    forceKillAfter: ENDS_WITHIN,
  });
  let said = "";
  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        said = (said + chunk).slice(-SAID_MOST);
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
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

/** A port nothing listens on right now. */
export const freePort = NodeSocketServer.make({ port: 0, host: "127.0.0.1" }).pipe(
  Effect.scoped,
  Effect.mapError((error) => new NoPort({ reason: error.message })),
  Effect.flatMap(({ address }) =>
    address._tag === "UnixPathAddress"
      ? Effect.fail(new NoPort({ reason: "the probe listens on a path" }))
      : Effect.succeed(address.port),
  ),
);

/** A directory of the scope's own, gone when it ends. Its path is short: sockets go below it. */
export const directory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  // `makeTempDirectoryScoped` removes once and dies of what is in its way: what ran here
  // may still be writing its last as it ends.
  return yield* Effect.acquireRelease(fs.makeTempDirectory({ prefix: "ap-e2e-" }), (path) =>
    fs
      .remove(path, { recursive: true, force: true })
      .pipe(
        Effect.retry(Schedule.spaced("200 millis").pipe(Schedule.upTo({ times: 10 }))),
        Effect.ignore,
      ),
  );
});
