import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { ProgramFailed } from "../errors.ts";
import { type ProgramOptions, Programs } from "./service.ts";

const environment = (options: ProgramOptions) => ({
  cwd: options.cwd,
  env: options.env,
  extendEnv: options.alone !== true,
});

export const makePrograms = Effect.fn("Programs.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const spawned = (program: string, args: readonly string[], command: ChildProcess.Command) => {
    const named = [program, ...args].join(" ");
    const failed = (error: PlatformError.PlatformError) =>
      new ProgramFailed({ program: named, reason: error.message });
    return spawner.spawn(command).pipe(
      Effect.mapError(failed),
      Effect.map((handle) => ({
        handle,
        failed,
        ended: handle.exitCode.pipe(
          Effect.mapError(failed),
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.fail(new ProgramFailed({ program: named, reason: `it ended with ${code}` })),
          ),
        ),
      })),
    );
  };

  // Not a group of its own: what a program leaves running, as `podman run --detach` leaves
  // the container's monitor, is not ended with it.
  const run = Effect.fn("Programs.run")(function* (
    program: string,
    args: readonly string[],
    options: ProgramOptions = {},
  ) {
    const output = options.quiet === true ? "ignore" : "inherit";
    const { ended } = yield* spawned(
      program,
      args,
      ChildProcess.make(program, args, {
        ...environment(options),
        stdin: "ignore",
        stdout: output,
        stderr: output,
        detached: false,
      }),
    );
    yield* ended;
  }, Effect.scoped);

  const read = Effect.fn("Programs.read")(function* (
    program: string,
    args: readonly string[],
    options: ProgramOptions = {},
  ) {
    const { handle, failed, ended } = yield* spawned(
      program,
      args,
      ChildProcess.make(program, args, {
        ...environment(options),
        stdin: "ignore",
        stdout: "pipe",
        stderr: options.both === true ? "pipe" : options.quiet === true ? "ignore" : "inherit",
        detached: false,
      }),
    );
    const said = yield* (options.both === true ? handle.all : handle.stdout).pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.mapError(failed),
    );
    yield* ended;
    return said;
  }, Effect.scoped);

  const start = Effect.fn("Programs.start")(function* (
    program: string,
    args: readonly string[],
    options: ProgramOptions & { readonly endsWithin: number },
  ) {
    const { handle } = yield* spawned(
      program,
      args,
      ChildProcess.make(program, args, {
        ...environment(options),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        killSignal: "SIGTERM",
        forceKillAfter: Duration.seconds(options.endsWithin),
      }),
    );
    return handle;
  });

  return Programs.of({ run, read, start });
});

export const layer = Layer.effect(Programs, makePrograms());
