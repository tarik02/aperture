import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";
import type { ProgramFailed } from "../errors.ts";

export interface ProgramOptions {
  readonly cwd?: string | undefined;
  /** Beside this tool's own environment, or in place of it where `alone` is set. */
  readonly env?: Record<string, string> | undefined;
  readonly alone?: boolean | undefined;
  /** What it writes is not shown. */
  readonly quiet?: boolean | undefined;
  /** What it writes to its error output is read with its output, as `2>&1` has it. */
  readonly both?: boolean | undefined;
}

export interface ProgramsShape {
  /** Runs a program to its end with this tool's output as its own; one that fails is an error. */
  readonly run: (
    program: string,
    args: readonly string[],
    options?: ProgramOptions,
  ) => Effect.Effect<void, ProgramFailed>;
  /**
   * Runs a program to its end for what it writes to its output, which is not shown; what it
   * writes to its error output is. One that fails is an error.
   */
  readonly read: (
    program: string,
    args: readonly string[],
    options?: ProgramOptions,
  ) => Effect.Effect<string, ProgramFailed>;
  /**
   * Starts a program in a process group of its own, for as long as the scope lasts: the
   * group is asked to end with it, and killed after `endsWithin` where it has not.
   * Both its outputs are the handle's to read.
   */
  readonly start: (
    program: string,
    args: readonly string[],
    options: ProgramOptions & { readonly endsWithin: number },
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, ProgramFailed, Scope.Scope>;
}

export class Programs extends Context.Service<Programs, ProgramsShape>()(
  "@aperture-browser/tools/Programs",
) {}
