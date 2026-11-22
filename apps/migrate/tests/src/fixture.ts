import { directory } from "@aperture-browser/e2e/src/process.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

/** The recorded v1 could not be laid out. */
export class FixtureUnusable extends Schema.TaggedError<FixtureUnusable>()("FixtureUnusable", {
  step: Schema.String,
}) {}

const done = (step: string, program: string, args: ReadonlyArray<string>) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.exitCode(
      ChildProcess.make(program, args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
    ),
  ).pipe(
    Effect.orElseSucceed(() => 1),
    Effect.flatMap((code) =>
      code === 0 ? Effect.void : Effect.fail(new FixtureUnusable({ step })),
    ),
  );

/** What says what a directory holds, to the byte: every file's digest, in order. */
export const digest = (dir: string) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.string(
      ChildProcess.make(
        "sh",
        ["-c", 'cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum', "sh", dir],
        {
          stdin: "ignore",
          stderr: "ignore",
        },
      ),
    ),
  );

/**
 * The v1 installation `fixture/record.sh` recorded from a real v1, laid out as v1 left it
 * and made read-only: a migrator that writes to it fails.
 */
export class V1 extends Context.Service<
  V1,
  {
    /** v1's store and cold root. */
    readonly dir: string;
    readonly database: string;
  }
>()("@aperture-browser/migrate/tests/V1") {}

export const layer = Layer.effect(
  V1,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const archive = yield* path.fromFileUrl(new URL("../fixture/v1.tar.gz", import.meta.url));
    const dir = yield* Effect.acquireRelease(directory, (made) =>
      // What is read-only is not removed with the directory otherwise.
      Effect.ignore(done("unlock", "chmod", ["-R", "u+w", made])),
    );
    yield* done("unpack", "tar", ["-xzf", archive, "-C", dir]);
    yield* done("lock", "chmod", ["-R", "a-w", dir]);
    return { dir, database: `${dir}/aperture.db` };
  }),
);
